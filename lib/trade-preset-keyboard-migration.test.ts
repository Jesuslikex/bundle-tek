import { expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import {
  defaultTradeAmountPresets,
  defaultTradePresetKeyboard,
} from './trade-amount-preferences';
import {
  readTradeAmountPreferences,
  saveTradeAmountPreferences,
} from './trade-amount-preferences-server';

it('retains pre-upgrade rows byte-for-byte and upgrades only through an explicit versioned save', async () => {
  const client = createClient({ url: 'file::memory:' });
  const apply = async (tag: string) => {
    for (const sql of readFileSync(`drizzle/${tag}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) await client.execute(sql);
  };
  try {
    await apply('0111_trade_amount_preferences');
    const db = createTursoDatabase(client);
    const legacy = defaultTradeAmountPresets();
    await saveTradeAmountPreferences(db, 'alice', 0, legacy);
    const before = (
      await client.execute('SELECT * FROM trade_amount_preferences')
    ).rows;
    await apply('0112_trade_preset_keyboard');
    expect(
      (await client.execute('SELECT * FROM trade_amount_preferences')).rows,
    ).toEqual(before);
    expect((await readTradeAmountPreferences(db, 'alice')).preferences).toEqual(
      legacy,
    );
    const preferences = {
      ...legacy,
      format: 'trade-amount-presets-v2' as const,
      keyboard: defaultTradePresetKeyboard(),
    };
    const saved = await saveTradeAmountPreferences(db, 'alice', 1, preferences);
    expect(saved).toMatchObject({ ownerId: 'alice', revision: 2, preferences });
    await expect(
      saveTradeAmountPreferences(db, 'alice', 1, preferences),
    ).rejects.toThrow('Reload');
    for (const sql of [
      "UPDATE trade_amount_preferences SET owner_id='bob',revision=3",
      "UPDATE trade_amount_preferences SET created_at='2000-01-01T00:00:00.000Z',revision=3",
      'DELETE FROM trade_amount_preferences',
    ])
      await expect(client.execute(sql)).rejects.toThrow();
    expect(await readTradeAmountPreferences(db, 'alice')).toEqual(saved);
  } finally {
    client.close();
  }
});
