CREATE TABLE `counter_proposal_reservations` (
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`decision_identity` text NOT NULL,
	`id` text NOT NULL,
	`project_revision` integer NOT NULL,
	`plan_revision` integer NOT NULL,
	`wallet_address` text NOT NULL,
	`wallet_revision` integer NOT NULL,
	`packet_sha256` text NOT NULL,
	`document` text NOT NULL,
	`expires_at` text NOT NULL,
	`approval_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `project_id`, `plan_id`, `decision_identity`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `counter_proposal_reservation_id` ON `counter_proposal_reservations` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `counter_proposal_reservation_approval` ON `counter_proposal_reservations` (`approval_id`);--> statement-breakpoint
CREATE INDEX `counter_proposal_reservation_scope` ON `counter_proposal_reservations` (`owner_id`,`project_id`,`plan_id`);
--> statement-breakpoint
CREATE TRIGGER counter_reservation_insert_guard BEFORE INSERT ON counter_proposal_reservations
BEGIN
 SELECT RAISE(ABORT,'invalid counter reservation') WHERE NEW.approval_id IS NOT NULL OR (((((json_valid(NEW.document) IS NOT 1
 OR length(NEW.document)>8192)
 OR (json_extract(NEW.document,'$.format') IS NOT 'counter-reservation-v1'
 OR json_extract(NEW.document,'$.executionAllowed') IS NOT 0))
 OR ((length(NEW.packet_sha256)<>64
 OR NEW.packet_sha256 GLOB '*[^0-9a-f]*')
 OR (NEW.project_revision NOT BETWEEN 1 AND 1000000000
 OR (NEW.plan_revision NOT BETWEEN 1 AND 1000000000
 OR NEW.wallet_revision NOT BETWEEN 1 AND 1000000000))))
 OR (((length(NEW.decision_identity) NOT BETWEEN 1 AND 512
 OR json_extract(NEW.document,'$.side') NOT IN ('Buy','Sell'))
 OR (json_type(NEW.document,'$.side') IS NOT 'text'
 OR NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 OR ((NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds')
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expires_at) IS NOT NEW.expires_at)
 OR (json_extract(NEW.document,'$.id') IS NOT NEW.id
 OR (json_extract(NEW.document,'$.projectId') IS NOT NEW.project_id
 OR json_extract(NEW.document,'$.planId') IS NOT NEW.plan_id)))))
 OR ((((json_extract(NEW.document,'$.projectRevision') IS NOT NEW.project_revision
 OR json_extract(NEW.document,'$.planRevision') IS NOT NEW.plan_revision)
 OR (json_extract(NEW.document,'$.decisionIdentity') IS NOT NEW.decision_identity
 OR json_extract(NEW.document,'$.wallet') IS NOT NEW.wallet_address))
 OR ((json_extract(NEW.document,'$.walletRevision') IS NOT NEW.wallet_revision
 OR json_extract(NEW.document,'$.sha256') IS NOT NEW.packet_sha256)
 OR (json_extract(NEW.document,'$.expiresAt') IS NOT NEW.expires_at
 OR (json_type(NEW.document,'$.proposalTokenRaw') IS NOT 'text'
 OR json_type(NEW.document,'$.maximumInputRaw') IS NOT 'text'))))
 OR (((json_type(NEW.document,'$.minimumOutputRaw') IS NOT 'text'
 OR json_type(NEW.document,'$.maximumFeeAndRentRaw') IS NOT 'text')
 OR (EXISTS(SELECT 1 FROM json_each(NEW.document) a WHERE a.key IN ('proposalTokenRaw','maximumInputRaw','minimumOutputRaw','maximumFeeAndRentRaw') AND (a.value GLOB '*[^0-9]*' OR length(a.value) NOT BETWEEN 1 AND 20 OR (length(a.value)>1 AND substr(a.value,1,1)='0') OR (length(a.value)=20 AND a.value>'18446744073709551615')))
 OR json_extract(NEW.document,'$.proposalTokenRaw')='0'))
 OR ((json_extract(NEW.document,'$.maximumInputRaw')='0'
 OR json_extract(NEW.document,'$.minimumOutputRaw')='0')
 OR ((json_extract(NEW.document,'$.side')='Buy' AND json_extract(NEW.document,'$.minimumOutputRaw') IS NOT json_extract(NEW.document,'$.proposalTokenRaw'))
 OR ((json_extract(NEW.document,'$.side')='Sell' AND json_extract(NEW.document,'$.maximumInputRaw') IS NOT json_extract(NEW.document,'$.proposalTokenRaw'))
 OR NOT EXISTS(SELECT 1 FROM counter_trade_plans c
 JOIN imported_token_projects p ON p.owner_id=c.owner_id AND p.id=c.project_id
 JOIN workspace_wallets w ON w.owner_id=c.owner_id AND w.chain='Solana' AND w.address=NEW.wallet_address
 JOIN json_each(c.document,'$.ledger.decisions') d
 WHERE c.owner_id=NEW.owner_id AND c.project_id=NEW.project_id AND c.id=NEW.plan_id
 AND c.state='active' AND c.revision=NEW.plan_revision
 AND json_extract(NEW.document,'$.mint')=p.address AND json_extract(NEW.document,'$.decimals')=json_extract(c.document,'$.ledger.scope.decimals')
 AND p.chain='Solana' AND p.archived=0 AND p.revision=NEW.project_revision AND w.archived=0 AND w.revision=NEW.wallet_revision
 AND json_extract(c.document,'$.projectDocument')=p.document
 AND json_extract(c.document,'$.ledger.scope.revision')=p.revision
 AND json_extract(c.document,'$.ledger.scope.mint')=p.address
 AND json_extract(p.document,'$.token.chain')='Solana' AND json_extract(p.document,'$.token.address')=p.address
 AND json_extract(p.document,'$.token.decimals')=json_extract(c.document,'$.ledger.scope.decimals')
 AND json_extract(c.document,'$.rules.responseSide')=json_extract(NEW.document,'$.side')
 AND json_extract(d.value,'$.identity')=NEW.decision_identity AND json_extract(d.value,'$.outcome')='proposal'
 AND json_extract(d.value,'$.proposalTokenRaw')=json_extract(NEW.document,'$.proposalTokenRaw')
 AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND o.address=w.address)
 AND NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND NOT EXISTS(SELECT 1 FROM json_each(c.document,'$.rules.ignoredWallets') x WHERE x.value=o.address)))))))));
END;
--> statement-breakpoint
CREATE TRIGGER counter_reservation_update_guard BEFORE UPDATE ON counter_proposal_reservations
BEGIN
 SELECT RAISE(ABORT,'counter reservation is immutable') WHERE OLD.approval_id IS NOT NULL OR NEW.owner_id IS NOT OLD.owner_id OR NEW.project_id IS NOT OLD.project_id OR NEW.plan_id IS NOT OLD.plan_id OR NEW.decision_identity IS NOT OLD.decision_identity OR NEW.created_at IS NOT OLD.created_at;
 SELECT RAISE(ABORT,'invalid counter reservation replacement') WHERE NEW.approval_id IS NULL AND (OLD.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR (((((json_valid(NEW.document) IS NOT 1
 OR length(NEW.document)>8192)
 OR (json_extract(NEW.document,'$.format') IS NOT 'counter-reservation-v1'
 OR json_extract(NEW.document,'$.executionAllowed') IS NOT 0))
 OR ((length(NEW.packet_sha256)<>64
 OR NEW.packet_sha256 GLOB '*[^0-9a-f]*')
 OR (NEW.project_revision NOT BETWEEN 1 AND 1000000000
 OR (NEW.plan_revision NOT BETWEEN 1 AND 1000000000
 OR NEW.wallet_revision NOT BETWEEN 1 AND 1000000000))))
 OR (((length(NEW.decision_identity) NOT BETWEEN 1 AND 512
 OR json_extract(NEW.document,'$.side') NOT IN ('Buy','Sell'))
 OR (json_type(NEW.document,'$.side') IS NOT 'text'
 OR NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 OR ((NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds')
 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expires_at) IS NOT NEW.expires_at)
 OR (json_extract(NEW.document,'$.id') IS NOT NEW.id
 OR (json_extract(NEW.document,'$.projectId') IS NOT NEW.project_id
 OR json_extract(NEW.document,'$.planId') IS NOT NEW.plan_id)))))
 OR ((((json_extract(NEW.document,'$.projectRevision') IS NOT NEW.project_revision
 OR json_extract(NEW.document,'$.planRevision') IS NOT NEW.plan_revision)
 OR (json_extract(NEW.document,'$.decisionIdentity') IS NOT NEW.decision_identity
 OR json_extract(NEW.document,'$.wallet') IS NOT NEW.wallet_address))
 OR ((json_extract(NEW.document,'$.walletRevision') IS NOT NEW.wallet_revision
 OR json_extract(NEW.document,'$.sha256') IS NOT NEW.packet_sha256)
 OR (json_extract(NEW.document,'$.expiresAt') IS NOT NEW.expires_at
 OR (json_type(NEW.document,'$.proposalTokenRaw') IS NOT 'text'
 OR json_type(NEW.document,'$.maximumInputRaw') IS NOT 'text'))))
 OR (((json_type(NEW.document,'$.minimumOutputRaw') IS NOT 'text'
 OR json_type(NEW.document,'$.maximumFeeAndRentRaw') IS NOT 'text')
 OR (EXISTS(SELECT 1 FROM json_each(NEW.document) a WHERE a.key IN ('proposalTokenRaw','maximumInputRaw','minimumOutputRaw','maximumFeeAndRentRaw') AND (a.value GLOB '*[^0-9]*' OR length(a.value) NOT BETWEEN 1 AND 20 OR (length(a.value)>1 AND substr(a.value,1,1)='0') OR (length(a.value)=20 AND a.value>'18446744073709551615')))
 OR json_extract(NEW.document,'$.proposalTokenRaw')='0'))
 OR ((json_extract(NEW.document,'$.maximumInputRaw')='0'
 OR json_extract(NEW.document,'$.minimumOutputRaw')='0')
 OR ((json_extract(NEW.document,'$.side')='Buy' AND json_extract(NEW.document,'$.minimumOutputRaw') IS NOT json_extract(NEW.document,'$.proposalTokenRaw'))
 OR ((json_extract(NEW.document,'$.side')='Sell' AND json_extract(NEW.document,'$.maximumInputRaw') IS NOT json_extract(NEW.document,'$.proposalTokenRaw'))
 OR NOT EXISTS(SELECT 1 FROM counter_trade_plans c
 JOIN imported_token_projects p ON p.owner_id=c.owner_id AND p.id=c.project_id
 JOIN workspace_wallets w ON w.owner_id=c.owner_id AND w.chain='Solana' AND w.address=NEW.wallet_address
 JOIN json_each(c.document,'$.ledger.decisions') d
 WHERE c.owner_id=NEW.owner_id AND c.project_id=NEW.project_id AND c.id=NEW.plan_id
 AND c.state='active' AND c.revision=NEW.plan_revision
 AND json_extract(NEW.document,'$.mint')=p.address AND json_extract(NEW.document,'$.decimals')=json_extract(c.document,'$.ledger.scope.decimals')
 AND p.chain='Solana' AND p.archived=0 AND p.revision=NEW.project_revision AND w.archived=0 AND w.revision=NEW.wallet_revision
 AND json_extract(c.document,'$.projectDocument')=p.document
 AND json_extract(c.document,'$.ledger.scope.revision')=p.revision
 AND json_extract(c.document,'$.ledger.scope.mint')=p.address
 AND json_extract(p.document,'$.token.chain')='Solana' AND json_extract(p.document,'$.token.address')=p.address
 AND json_extract(p.document,'$.token.decimals')=json_extract(c.document,'$.ledger.scope.decimals')
 AND json_extract(c.document,'$.rules.responseSide')=json_extract(NEW.document,'$.side')
 AND json_extract(d.value,'$.identity')=NEW.decision_identity AND json_extract(d.value,'$.outcome')='proposal'
 AND json_extract(d.value,'$.proposalTokenRaw')=json_extract(NEW.document,'$.proposalTokenRaw')
 AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND o.address=w.address)
 AND NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=c.owner_id AND o.chain='Solana' AND NOT EXISTS(SELECT 1 FROM json_each(c.document,'$.rules.ignoredWallets') x WHERE x.value=o.address))))))))));
 SELECT RAISE(ABORT,'invalid counter approval binding') WHERE NEW.approval_id IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.project_revision IS NOT OLD.project_revision OR NEW.plan_revision IS NOT OLD.plan_revision OR NEW.wallet_address IS NOT OLD.wallet_address OR NEW.wallet_revision IS NOT OLD.wallet_revision OR NEW.packet_sha256 IS NOT OLD.packet_sha256 OR NEW.document IS NOT OLD.document OR NEW.expires_at IS NOT OLD.expires_at OR NOT EXISTS(SELECT 1 FROM imported_swap_signing_intents i WHERE i.owner_id=NEW.owner_id AND i.id=NEW.approval_id AND i.preparation_id=NEW.id AND i.wallet_address=NEW.wallet_address AND i.state='awaiting_signature' AND i.signature IS NULL AND json_extract(i.document,'$.sha256')=NEW.packet_sha256 AND json_extract(i.document,'$.counter.claimId')=NEW.id));
END;
--> statement-breakpoint
CREATE TRIGGER counter_reservation_delete_guard BEFORE DELETE ON counter_proposal_reservations
BEGIN
 SELECT RAISE(ABORT,'counter proposal history is retained');
END;
--> statement-breakpoint
CREATE TRIGGER counter_approval_reservation_guard BEFORE INSERT ON imported_swap_signing_intents
WHEN json_extract(NEW.document,'$.format')='counter-signing-review-v1' OR json_type(NEW.document,'$.counter') IS NOT NULL OR EXISTS(SELECT 1 FROM imported_swap_preparations s WHERE s.owner_id=NEW.owner_id AND s.id=NEW.preparation_id AND json_type(s.document,'$.counter') IS NOT NULL)
BEGIN
 SELECT RAISE(ABORT,'counter approval requires its reserved proposal') WHERE json_extract(NEW.document,'$.format') IS NOT 'counter-signing-review-v1' OR NEW.state IS NOT 'awaiting_signature' OR NEW.signature IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM counter_proposal_reservations r JOIN imported_swap_preparations s ON s.owner_id=r.owner_id AND s.id=r.id
 JOIN counter_trade_plans c ON c.owner_id=r.owner_id AND c.project_id=r.project_id AND c.id=r.plan_id
 JOIN imported_token_projects p ON p.owner_id=r.owner_id AND p.id=r.project_id
 JOIN workspace_wallets w ON w.owner_id=r.owner_id AND w.chain='Solana' AND w.address=r.wallet_address
 WHERE ((((r.owner_id=NEW.owner_id AND r.id=NEW.preparation_id AND r.id=json_extract(NEW.document,'$.counter.claimId') AND r.approval_id IS NULL AND r.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND r.wallet_address=NEW.wallet_address AND r.packet_sha256=json_extract(NEW.document,'$.sha256'))
 AND (json_extract(NEW.document,'$.id')=NEW.id AND json_extract(NEW.document,'$.preparationId')=r.id AND json_extract(NEW.document,'$.wallet')=r.wallet_address AND json_extract(NEW.document,'$.expiresAt')=r.expires_at
 AND json_extract(NEW.document,'$.counter.maximumInputRaw')=json_extract(r.document,'$.maximumInputRaw') AND json_extract(NEW.document,'$.counter.minimumOutputRaw')=json_extract(r.document,'$.minimumOutputRaw') AND json_extract(NEW.document,'$.counter.maximumFeeAndRentRaw')=json_extract(r.document,'$.maximumFeeAndRentRaw')))
 AND ((json_extract(NEW.document,'$.counter.projectId')=r.project_id AND json_extract(NEW.document,'$.counter.projectRevision')=r.project_revision AND json_extract(NEW.document,'$.counter.planId')=r.plan_id AND json_extract(NEW.document,'$.counter.planRevision')=r.plan_revision
 AND json_extract(NEW.document,'$.counter.decisionIdentity')=r.decision_identity AND json_extract(NEW.document,'$.counter.side')=json_extract(r.document,'$.side') AND json_extract(NEW.document,'$.counter.proposalTokenRaw')=json_extract(r.document,'$.proposalTokenRaw'))
 AND (json_extract(NEW.document,'$.inputRaw')=json_extract(r.document,'$.maximumInputRaw') AND json_extract(NEW.document,'$.minimumOutputRaw')=json_extract(r.document,'$.minimumOutputRaw')
 AND json_extract(NEW.document,'$.swapMode')= CASE json_extract(r.document,'$.side') WHEN 'Buy' THEN 'ExactOut' ELSE 'ExactIn' END)))
 AND (((json_extract(NEW.document,'$.inputMint')= CASE json_extract(r.document,'$.side') WHEN 'Buy' THEN 'So11111111111111111111111111111111111111112' ELSE p.address END
 AND json_extract(NEW.document,'$.outputMint')= CASE json_extract(r.document,'$.side') WHEN 'Sell' THEN 'So11111111111111111111111111111111111111112' ELSE p.address END)
 AND (s.project_id=r.project_id AND s.project_revision=r.project_revision AND s.wallet_revision=r.wallet_revision AND s.wallet_address=r.wallet_address AND json_extract(s.document,'$.transaction.sha256')=r.packet_sha256 AND json_extract(s.document,'$.counter.claimId')=r.id
 AND c.state='active' AND c.revision>=r.plan_revision AND p.chain='Solana' AND p.archived=0 AND p.revision=r.project_revision AND w.archived=0 AND w.revision=r.wallet_revision))
 AND ((json_extract(c.document,'$.projectDocument')=p.document
 AND p.address=json_extract(r.document,'$.mint') AND json_extract(p.document,'$.token.address')=p.address AND json_extract(p.document,'$.token.decimals')=json_extract(r.document,'$.decimals'))
 AND (EXISTS(SELECT 1 FROM json_each(c.document,'$.ledger.decisions') d WHERE json_extract(d.value,'$.identity')=r.decision_identity AND json_extract(d.value,'$.outcome')='proposal' AND json_extract(d.value,'$.proposalTokenRaw')=json_extract(r.document,'$.proposalTokenRaw'))
 AND (EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=r.owner_id AND o.chain='Solana' AND o.address=w.address)
 AND NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=r.owner_id AND o.chain='Solana' AND NOT EXISTS(SELECT 1 FROM json_each(c.document,'$.rules.ignoredWallets') x WHERE x.value=o.address)))))))
 );
END;
--> statement-breakpoint
CREATE TRIGGER counter_approval_reservation_bind AFTER INSERT ON imported_swap_signing_intents
WHEN json_extract(NEW.document,'$.format')='counter-signing-review-v1'
BEGIN
 UPDATE counter_proposal_reservations SET approval_id=NEW.id,updated_at=NEW.updated_at WHERE owner_id=NEW.owner_id AND id=json_extract(NEW.document,'$.counter.claimId') AND approval_id IS NULL;
 SELECT RAISE(ABORT,'counter proposal was already approved') WHERE changes()<>1;
END;
--> statement-breakpoint
CREATE TRIGGER counter_bound_approval_delete_guard BEFORE DELETE ON imported_swap_signing_intents
WHEN EXISTS(SELECT 1 FROM counter_proposal_reservations r WHERE r.owner_id=OLD.owner_id AND r.approval_id=OLD.id)
BEGIN
 SELECT RAISE(ABORT,'counter approval history is retained');
END;
