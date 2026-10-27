import sqlite3, time

c = sqlite3.connect('dev.db')
now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
c.execute(
    "update warmup_signing_intents set state='failed', updated_at=? where id=?",
    (now, 'c673ce7b-fe3f-4bbf-a296-33247e8586e5'),
)
c.execute(
    "delete from solana_swap_reservations where intent_id=?",
    ('c673ce7b-fe3f-4bbf-a296-33247e8586e5',),
)
c.commit()
print(list(c.execute("select state from warmup_signing_intents where id='c673ce7b-fe3f-4bbf-a296-33247e8586e5'")))
print(list(c.execute('select count(*) from solana_swap_reservations')))
