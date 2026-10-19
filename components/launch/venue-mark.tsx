import { TOKEN_LOGOS } from './token-logos';

// Chain and launchpad marks for the launch picker. Logos are the projects'
// own published marks (Trust Wallet asset repo); everything else falls back
// to a coloured monogram until an official logo is added to public/logos.
const LOGOS: Record<string, string> = {
  Solana: '/logos/solana.png',
  SOL: '/logos/solana.png',
  USDC: '/logos/usdc.png',
  BONK: '/logos/letsbonk.png',
  Ethereum: '/logos/ethereum.png',
  Base: '/logos/base.png',
  BNB: '/logos/bnb.png',
  PumpFun: '/logos/pumpfun.png',
  FourMeme: '/logos/fourmeme.png',
  Flap: '/logos/flap.png',
  'flap.sh': '/logos/flap.png',
  'Uniswap V2': '/logos/uniswap.png',
  'Uniswap V3': '/logos/uniswap.png',
  'Uniswap V4': '/logos/uniswap.png',
  Robinhood: '/logos/robinhood.png',
  Arc: '/logos/arc.png',
  LetsBonk: '/logos/letsbonk.png',
  Bags: '/logos/bags.png',
  Anoncoin: '/logos/anoncoin.png',
  'Meteora DBC': '/logos/meteora.svg',
  Stoxes: '/logos/stoxes.png',
  Lesgo: '/logos/lesgo.png',
  'meme.fun': '/logos/memefun.png',
  Clanker: '/logos/clanker.png',
  Bankr: '/logos/bankr.png',
  Raydium: '/logos/raydium.png',
};

const COLORS: Record<string, string> = {
  Robinhood: '#c7e448',
  Arc: '#e6e8ef',
  LetsBonk: '#f2913d',
  Bags: '#2bd46b',
  Anoncoin: '#a98bff',
  Surge: '#e6e8ef',
  Printr: '#ff6f8a',
  'Meteora DBC': '#ff6d3a',
  StonkFun: '#6fc7e8',
  Stoxes: '#2fe0a0',
  Lesgo: '#ffd21f',
  'meme.fun': '#c9ccd6',
  Clanker: '#8b6cff',
  Bankr: '#ff9a3d',
};

export function VenueMark({
  name,
  address,
  size = 20,
}: {
  name: string;
  address?: string;
  size?: number;
}) {
  const logo =
    address && TOKEN_LOGOS.has(address)
      ? `/logos/tokens/${address}.png`
      : LOGOS[name];
  if (logo)
    return (
      // Plain img: tiny static marks, no layout shift, no optimizer needed.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="venue-mark"
        src={logo}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
      />
    );
  const color = COLORS[name] ?? '#afb1e7';
  return (
    <span
      className="venue-mark venue-monogram"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        color,
        borderColor: `${color}55`,
        background: `${color}1f`,
      }}
    >
      {name
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 1)
        .toUpperCase()}
    </span>
  );
}
