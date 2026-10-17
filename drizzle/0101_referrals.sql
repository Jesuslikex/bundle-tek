CREATE TABLE referral_codes(
 owner_id TEXT PRIMARY KEY NOT NULL,code TEXT NOT NULL UNIQUE CHECK(length(code)=8),created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE referrals(
 member_id TEXT PRIMARY KEY NOT NULL,referrer_id TEXT NOT NULL,code TEXT NOT NULL,created_at TEXT NOT NULL,
 CHECK(member_id<>referrer_id)
);
--> statement-breakpoint
CREATE INDEX referrals_referrer ON referrals(referrer_id,created_at);
--> statement-breakpoint
CREATE TRIGGER referrals_insert BEFORE INSERT ON referrals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM referral_codes WHERE code=NEW.code AND owner_id=NEW.referrer_id) THEN RAISE(ABORT,'Unknown referral code') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM referrals WHERE member_id=NEW.referrer_id AND referrer_id=NEW.member_id) THEN RAISE(ABORT,'Referral loop') END;
END;
--> statement-breakpoint
CREATE TRIGGER referrals_immutable BEFORE UPDATE ON referrals BEGIN
 SELECT RAISE(ABORT,'Referrals are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER referral_codes_immutable BEFORE UPDATE ON referral_codes BEGIN
 SELECT RAISE(ABORT,'Referral codes are immutable');
END;
