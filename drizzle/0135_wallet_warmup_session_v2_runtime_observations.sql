CREATE TABLE wallet_warmup_session_v2_attempt_purposes (
 owner_id TEXT NOT NULL,attempt_id TEXT NOT NULL,journal_id TEXT NOT NULL,review_version INTEGER NOT NULL,
 review_sha256 TEXT NOT NULL,terms_sha256 TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('preview','runtime')),
 request_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,attempt_id),
 FOREIGN KEY(owner_id,attempt_id) REFERENCES wallet_warmup_session_v2_attempts(owner_id,id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_v2_purpose_identity ON wallet_warmup_session_v2_attempt_purposes(attempt_id);
--> statement-breakpoint
CREATE TABLE wallet_warmup_session_v2_runtime_observations (
 owner_id TEXT NOT NULL,attempt_id TEXT NOT NULL,purpose_sha256 TEXT NOT NULL,packet_sha256 TEXT NOT NULL,
 document TEXT NOT NULL CHECK(typeof(document)='text' AND json_valid(document) AND length(CAST(document AS BLOB)) BETWEEN 1 AND 262144),
 document_sha256 TEXT NOT NULL,outcome_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,attempt_id),
 FOREIGN KEY(owner_id,attempt_id) REFERENCES wallet_warmup_session_v2_attempt_purposes(owner_id,attempt_id),
 FOREIGN KEY(owner_id,attempt_id) REFERENCES wallet_warmup_session_v2_attempt_outcomes(owner_id,attempt_id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE UNIQUE INDEX warmup_v2_runtime_packet ON wallet_warmup_session_v2_runtime_observations(owner_id,packet_sha256);
--> statement-breakpoint
CREATE TRIGGER warmup_v2_purpose_insert BEFORE INSERT ON wallet_warmup_session_v2_attempt_purposes BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempt_purposes WHERE attempt_id=NEW.attempt_id)
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempts WHERE id=NEW.attempt_id)
 OR length(NEW.request_sha256)!=64 OR NEW.request_sha256 GLOB '*[^a-f0-9]*'
 OR NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempt_context c WHERE c.owner_id=NEW.owner_id AND c.journal_id=NEW.journal_id
 AND c.version=NEW.review_version AND c.head_sha256=NEW.review_sha256 AND c.terms_sha256=NEW.terms_sha256
 AND NEW.created_at>=c.head_updated_at AND NEW.created_at<c.finish_at)
 THEN RAISE(ABORT,'Warmup request purpose is unavailable') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_purpose_no_update BEFORE UPDATE ON wallet_warmup_session_v2_attempt_purposes BEGIN SELECT RAISE(ABORT,'Warmup purpose is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_purpose_no_delete BEFORE DELETE ON wallet_warmup_session_v2_attempt_purposes BEGIN SELECT RAISE(ABORT,'Warmup purpose is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_attempt_requires_purpose AFTER INSERT ON wallet_warmup_session_v2_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempt_purposes p WHERE p.owner_id=NEW.owner_id AND p.attempt_id=NEW.id
 AND p.journal_id=NEW.journal_id AND p.review_version=NEW.review_version AND p.review_sha256=NEW.review_sha256
 AND p.terms_sha256=NEW.terms_sha256 AND p.created_at<=NEW.created_at)
 THEN RAISE(ABORT,'Warmup attempt requires its original purpose') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_runtime_insert BEFORE INSERT ON wallet_warmup_session_v2_runtime_observations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_v2_runtime_observations WHERE owner_id=NEW.owner_id AND (attempt_id=NEW.attempt_id OR packet_sha256=NEW.packet_sha256))
 OR EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempt_outcomes WHERE owner_id=NEW.owner_id AND attempt_id=NEW.attempt_id)
 OR length(NEW.document_sha256)!=64 OR NEW.document_sha256 GLOB '*[^a-f0-9]*'
 OR length(NEW.outcome_sha256)!=64 OR NEW.outcome_sha256 GLOB '*[^a-f0-9]*'
 OR length(NEW.packet_sha256)!=64 OR NEW.packet_sha256 GLOB '*[^a-f0-9]*'
 OR NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) OR NEW.created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expires_at)
 OR NOT EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempts a
 JOIN wallet_warmup_session_v2_attempt_purposes p ON p.owner_id=a.owner_id AND p.attempt_id=a.id
 JOIN wallet_warmup_session_v2_attempt_context c ON c.owner_id=a.owner_id AND c.journal_id=a.journal_id AND c.version=a.review_version AND c.head_sha256=a.review_sha256 AND c.terms_sha256=a.terms_sha256 AND c.action_id=a.action_id
 WHERE a.owner_id=NEW.owner_id AND a.id=NEW.attempt_id AND p.mode='runtime' AND p.request_sha256=NEW.purpose_sha256
 AND NEW.created_at>=a.created_at AND NEW.created_at<a.expires_at AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<a.expires_at
 AND NEW.expires_at<=a.expires_at AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND json_extract(NEW.document,'$.format')='wallet-warmup-retained-runtime-v1'
 AND json_extract(NEW.document,'$.runtimeExpiresAt')>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND json_extract(NEW.document,'$.runtimeExpiresAt')<=NEW.expires_at
 AND json_extract(NEW.document,'$.runtimeExpiresAt')=strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.document,'$.runtimeExpiresAt'))
 AND json_extract(NEW.document,'$.purposeSha256')=p.request_sha256 AND json_extract(NEW.document,'$.packetSha256')=NEW.packet_sha256
 AND json_extract(NEW.document,'$.wallet')=c.wallet_address AND json_extract(NEW.document,'$.actionId')=c.action_id
 AND json_type(NEW.document,'$.feeAndRentLimitRaw')='text'
 AND EXISTS(SELECT 1 FROM json_each(c.review_document,'$.wallets') w WHERE json_extract(w.value,'$.wallet')=c.wallet_address AND json_extract(w.value,'$.remainingFeeReserveLamports')=json_extract(NEW.document,'$.feeAndRentLimitRaw'))
 AND json_extract(NEW.document,'$.referenceMinimum')='order-self' AND json_extract(NEW.document,'$.codeClockPolicy')='context-slot-floor-only'
 AND json_type(NEW.document,'$.signingAllowed') IS 'false' AND json_type(NEW.document,'$.executionAllowed') IS 'false'
 AND json_type(NEW.document,'$.programCodeAttested') IS 'false' AND json_type(NEW.document,'$.trustedProgramPolicyEstablished') IS 'false'
 AND json_type(NEW.document,'$.independentPriceProtectionEstablished') IS 'false'
 AND json_extract(NEW.document,'$.runtime.format')='pair-order-runtime-preview-v1'
 AND json_extract(NEW.document,'$.runtime.packetSha256')=NEW.packet_sha256 AND json_extract(NEW.document,'$.runtime.expiresAt')=json_extract(NEW.document,'$.runtimeExpiresAt')
 AND json_type(NEW.document,'$.runtime.codeIdentityObserved') IS 'true'
 AND json_type(NEW.document,'$.runtime.signingAllowed') IS 'false' AND json_type(NEW.document,'$.runtime.executionAllowed') IS 'false'
 AND json_type(NEW.document,'$.runtime.programCodeAttested') IS 'false' AND json_type(NEW.document,'$.runtime.trustedProgramPolicyEstablished') IS 'false'
 AND json_type(NEW.document,'$.runtime.semanticAuditEstablished') IS 'false' AND json_type(NEW.document,'$.runtime.innerInstructionPolicyVerified') IS 'false'
 AND json_type(NEW.document,'$.minimumSlot')='integer' AND json_type(NEW.document,'$.maximumSlot')='integer'
 AND json_extract(NEW.document,'$.minimumSlot')>=1 AND json_extract(NEW.document,'$.maximumSlot')>=json_extract(NEW.document,'$.minimumSlot')
 AND json_extract(NEW.document,'$.maximumSlot')-json_extract(NEW.document,'$.minimumSlot')<=32
 AND json_array_length(NEW.document,'$.codeScans')=2 AND json_extract(NEW.document,'$.codeScans[0]')=json_extract(NEW.document,'$.codeScans[1]')
 AND json_extract(NEW.document,'$.runtime.programs')=json_extract(NEW.document,'$.codeScans[1]')
 AND json_array_length(NEW.document,'$.codeScans[0]') BETWEEN 1 AND 16)
 THEN RAISE(ABORT,'Warmup runtime observation expired or changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_runtime_no_update BEFORE UPDATE ON wallet_warmup_session_v2_runtime_observations BEGIN SELECT RAISE(ABORT,'Warmup runtime observations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_runtime_no_delete BEFORE DELETE ON wallet_warmup_session_v2_runtime_observations BEGIN SELECT RAISE(ABORT,'Warmup runtime observations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER warmup_v2_runtime_outcome BEFORE INSERT ON wallet_warmup_session_v2_attempt_outcomes
WHEN EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempt_purposes WHERE owner_id=NEW.owner_id AND attempt_id=NEW.attempt_id AND mode='runtime') BEGIN
 SELECT CASE WHEN (NEW.kind='prepared' AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_v2_runtime_observations r WHERE r.owner_id=NEW.owner_id AND r.attempt_id=NEW.attempt_id
 AND r.packet_sha256=NEW.packet_sha256 AND r.outcome_sha256=NEW.record_sha256 AND r.created_at=NEW.created_at AND r.expires_at=NEW.expires_at))
 OR (NEW.kind='refused' AND EXISTS(SELECT 1 FROM wallet_warmup_session_v2_runtime_observations WHERE owner_id=NEW.owner_id AND attempt_id=NEW.attempt_id))
 THEN RAISE(ABORT,'Runtime outcome requires matching atomic observations') END;
END;
