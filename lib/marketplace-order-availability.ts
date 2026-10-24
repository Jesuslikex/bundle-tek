/** True once 0147 is applied; catalog filtering and checkout need it. No writes. */
export async function marketplaceOrdersInstalled(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('marketplace_orders_insert','marketplace_orders_update','marketplace_orders_no_delete','marketplace_orders_hold_release','marketplace_orders_sold_wallets','marketplace_deliveries_insert','marketplace_deliveries_no_update','marketplace_deliveries_no_delete')",
    )
    .first<{ n: number }>();
  return row?.n === 8;
}
/** SQL fragment for the catalog: wallets in a signed, sent or paid order are sold. */
export const unsoldMarketplaceWallet = `NOT EXISTS (
 SELECT 1 FROM marketplace_orders sold,json_each(sold.addresses) sold_wallet
 WHERE sold_wallet.value=p.wallet_address AND sold.state IN ('signed','submitted','paid')
)`;
