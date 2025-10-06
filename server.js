require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   REQUIRED ENV (work-or-fail)
   ========================= */
if (!process.env.LW_START_SAT || !process.env.LW_SUPPLY) {
  console.error('CRITICAL: LW_START_SAT and LW_SUPPLY must be set!');
  process.exit(1);
}
const LW_START_SAT = BigInt(process.env.LW_START_SAT);
const LW_SUPPLY    = BigInt(process.env.LW_SUPPLY);
const LW_END_SAT   = LW_START_SAT + LW_SUPPLY - 1n;

if (!process.env.ORDINAL_BOT_API_KEY) {
  console.error('CRITICAL: ORDINAL_BOT_API_KEY not set!');
  process.exit(1);
}
const ORDINAL_BOT_API_KEY = process.env.ORDINAL_BOT_API_KEY;

/* =========================
   CORS / Middleware
   ========================= */
app.use(cors({
  origin: [
    'https://kanetix.github.io',
    'https://kanetix.io',
    'https://www.kanetix.io'
  ],
  credentials: true
}));
app.use(express.json());

/* =========================
   External API clients
   ========================= */
const OB = axios.create({
  baseURL: 'https://api.ordinalsbot.com',
  headers: { 'x-api-key': ORDINAL_BOT_API_KEY, 'Content-Type': 'application/json' }
});

const HIRO_API_KEY = process.env.HIRO_API_KEY || '';
const Hiro = axios.create({
  baseURL: 'https://api.hiro.so/ordinals/v1',
  headers: Object.assign({ Accept: 'application/json' }, HIRO_API_KEY ? { 'x-api-key': HIRO_API_KEY } : {})
});

/* =========================
   Helpers (Hiro-based)
   ========================= */
function inRange(satBig) {
  return satBig >= LW_START_SAT && satBig <= LW_END_SAT;
}

// modest concurrency pool
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      if (i >= items.length) break;
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/* =========================
   Fees via mempool.space
   ========================= */
const feeCache = new NodeCache({ stdTTL: 30 }); // 30s
async function getCurrentFeeRates() {
  const cached = feeCache.get('feeRates');
  if (cached) return cached;

  const { data } = await axios.get('https://mempool.space/api/v1/fees/recommended');
  if (
    typeof data.economyFee !== 'number' ||
    typeof data.hourFee !== 'number' ||
    typeof data.fastestFee !== 'number'
  ) {
    throw new Error('Invalid fee data from mempool.space');
  }

  const feeRates = {
    low: data.economyFee,
    medium: data.hourFee,
    high: data.fastestFee,
    timestamp: Date.now()
  };
  feeCache.set('feeRates', feeRates);
  return feeRates;
}

/* =========================
   Routes
   ========================= */

// Health
app.get('/', (req, res) => {
  res.json({
    status: 'Light Waves Reveal API is running',
    version: '3.0.0',
    env: {
      LW_START_SAT: process.env.LW_START_SAT,
      LW_SUPPLY: process.env.LW_SUPPLY,
      HIRO_API: true,
      OB_API: true
    },
    endpoints: {
      'POST /api/check-wallet': 'Classify wallet holdings using Hiro (unrevealed vs revealed)',
      'GET /api/fee-rates': 'Get current fee rates (mempool.space)',
      'POST /api/create-reveal': 'Create reinscription order (OrdinalsBot)',
      'GET /api/order-status/:orderId': 'Check order status (OrdinalsBot)'
    }
  });
});

/**
 * POST /api/check-wallet
 * body: { address: string }
 * returns:
 * {
 *   status: 'success',
 *   unrevealed: [{ id, satOrdinal, revealed:false, label }],
 *   totals: { owned, inRange, unrevealed }
 * }
 *
 * Stateless logic (Hiro):
 *  1) list wallet inscriptions (paged)
 *  2) ensure sat_ordinal for each
 *  3) filter to [LW_START_SAT, LW_END_SAT]
 *  4) per unique sat -> /sats/{sat}/inscriptions?limit=1 to get total
 *  5) unrevealed if total === 1
 */
app.post('/api/check-wallet', async (req, res) => {
  try {
    const { address } = req.body || {};
    if (!address) return res.status(400).json({ status: 'error', error: 'Wallet address required' });

    // 1) list wallet inscriptions (paged)
    const perPage = 200;
    let offset = 0;
    const owned = [];
    while (true) {
      const { data: page } = await Hiro.get('/inscriptions', {
        params: { address, limit: perPage, offset }
      });
      const results = page?.results || [];
      owned.push(...results);
      offset += perPage;
      if (owned.length >= (page?.total || 0)) break;
    }

    if (owned.length === 0) {
      return res.json({ status: 'success', unrevealed: [], totals: { owned: 0, inRange: 0, unrevealed: 0 } });
    }

    // 2) ensure sat_ordinal for each
    const withSat = await mapPool(owned, 12, async (ins) => {
      if (ins.sat_ordinal !== undefined && ins.sat_ordinal !== null) return ins;
      const { data: full } = await Hiro.get(`/inscriptions/${ins.id}`);
      return { ...ins, sat_ordinal: full.sat_ordinal };
    });

    // 3) filter to collection sat range
    const candidates = withSat
      .filter((ins) => ins.sat_ordinal !== undefined && ins.sat_ordinal !== null)
      .map((ins) => ({ ...ins, satBig: BigInt(ins.sat_ordinal) }))
      .filter((ins) => inRange(ins.satBig));

    if (candidates.length === 0) {
      return res.json({ status: 'success', unrevealed: [], totals: { owned: owned.length, inRange: 0, unrevealed: 0 } });
    }

    // 4) per unique sat -> get total inscriptions on that sat
    const uniqueSatStrs = [...new Set(candidates.map((c) => c.satBig.toString()))];
    const satTotals = await mapPool(uniqueSatStrs, 12, async (satStr) => {
      const { data } = await Hiro.get(`/sats/${satStr}/inscriptions`, { params: { limit: 1, offset: 0 } });
      return { satStr, total: data?.total || 0 };
    });
    const totalsBySat = new Map(satTotals.map(x => [x.satStr, x.total]));

    // 5) unrevealed = total === 1
    const unrevealed = candidates
      .filter((c) => (totalsBySat.get(c.satBig.toString()) ?? 0) === 1)
      .map((c) => ({
        id: c.id,
        revealed: false,
        satOrdinal: c.satBig.toString(),
        label: `Sat ${c.satBig.toString()}`
      }));

    return res.json({
      status: 'success',
      unrevealed,
      totals: { owned: owned.length, inRange: candidates.length, unrevealed: unrevealed.length }
    });
  } catch (err) {
    console.error('Hiro check failure:', err?.response?.status, err?.response?.data || err?.message);
    // Work-or-fail: no fallback to HTML scraping
    return res.status(502).json({ status: 'error', error: 'Hiro API failed', details: err?.message || String(err) });
  }
});

/**
 * POST /api/create-reveal
 * body: { lightWaveIds: string[], receiveAddress: string, feeLevel: 'low'|'medium'|'high' }
 * Notes:
 *  - Keeps your OB flow; you’re reinscribing with a blank text child.
 */
app.post('/api/create-reveal', async (req, res) => {
  try {
    const { lightWaveIds, receiveAddress, feeLevel = 'medium' } = req.body || {};
    if (!Array.isArray(lightWaveIds) || lightWaveIds.length === 0) {
      return res.status(400).json({ error: 'Light Wave IDs required' });
    }
    if (!receiveAddress) {
      return res.status(400).json({ error: 'Receive address required' });
    }

    const feeRates = await getCurrentFeeRates();
    const feeRate = feeRates[feeLevel];
    if (!feeRate) throw new Error(`Invalid fee level: ${feeLevel}`);

    // Your OB payload as provided
    const orderData = {
      inscriptionIds: lightWaveIds,
      fee: feeRate,
      receiveAddress,
      reinscribe: true,
      childInscription: {
        contentType: 'text/plain',
        content: '' // blank file to reveal
      }
    };

    const { data } = await OB.post('/reinscribe', orderData);
    return res.json({
      status: 'success',
      orderId: data.id,
      charge: data.charge,
      inscriptionCount: lightWaveIds.length,
      feeRate,
      totalAmount: data.charge?.amount || 0,
      paymentAddress: data.charge?.address,
      lightningInvoice: data.charge?.lightning?.address
    });
  } catch (error) {
    console.error('OrdinalsBot error:', error?.response?.data || error?.message);
    return res.status(500).json({
      error: 'Failed to create reveal order',
      details: error?.response?.data?.error || error?.message
    });
  }
});

// Fees
app.get('/api/fee-rates', async (_req, res) => {
  try {
    const feeRates = await getCurrentFeeRates();
    res.json(feeRates);
  } catch (error) {
    console.error('Fee fetch error:', error?.message);
    res.status(500).json({ error: 'Failed to fetch fee rates', details: error?.message });
  }
});

// Order status passthrough
app.get('/api/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { data } = await OB.get(`/order/${orderId}`);
    res.json({ status: 'success', order: data });
  } catch (error) {
    console.error('Order status error:', error?.response?.data || error?.message);
    res.status(500).json({ error: 'Failed to fetch order status', details: error?.message });
  }
});

/* =========================
   Start
   ========================= */
app.listen(PORT, () => {
  console.log(`Light Waves Reveal API running on port ${PORT}`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
  console.log('OB API key configured:', !!ORDINAL_BOT_API_KEY);
  console.log('Hiro API key configured:', !!HIRO_API_KEY);
  console.log('Sat range:', process.env.LW_START_SAT, '→', (LW_END_SAT).toString());
});
