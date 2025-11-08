const API_BASE = 'https://api.coincap.io/v2';
const MAX_COINS = 20;
const chartCanvas = document.getElementById('rsiChart');
const periodSelect = document.getElementById('period-select');
const rangeSelect = document.getElementById('range-select');
const refreshButton = document.getElementById('refresh-btn');
const statusEl = document.getElementById('status');

let rsiChart = null;
let cachedCoins = [];
const historyCache = new Map();
let lastRequestTime = 0;
let isLoading = false;
let loadQueued = false;
let queueForceRefresh = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, options = {}) {
    const { retries = 3, retryDelay = 1500, ...rest } = options;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const response = await fetch(url, { mode: 'cors', ...rest });

            if (response.status === 429) {
                if (attempt === retries) {
                    throw new Error('Rate limited by upstream service');
                }

                const retryAfter = Number(response.headers.get('retry-after'));
                const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : retryDelay;
                await delay(delayMs);
                continue;
            }

            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}`);
            }

            return response.json();
        } catch (error) {
            if (attempt === retries) {
                throw error;
            }
            await delay(retryDelay);
        }
    }

    throw new Error('Unexpected fetch retry exhaustion');
}

const palette = [
    '#38bdf8', '#f97316', '#facc15', '#34d399', '#a855f7', '#ec4899', '#22d3ee', '#f87171', '#c084fc', '#4ade80',
    '#60a5fa', '#fb7185', '#fbbf24', '#2dd4bf', '#818cf8', '#f472b6', '#14b8a6', '#e879f9', '#93c5fd', '#f59e0b'
];

async function rateLimitedFetchJson(url, options) {
    const now = Date.now();
    const waitFor = Math.max(0, RATE_LIMIT_DELAY_MS - (now - lastRequestTime));
    if (waitFor > 0) {
        await delay(waitFor);
    }
    lastRequestTime = Date.now();
    return fetchJson(url, options);
}

async function fetchTopCoins() {
    if (cachedCoins.length > 0) {
        return cachedCoins;
    }

    setStatus('Fetching top cryptocurrencies…');
    const url = `${API_BASE}/assets?limit=${MAX_COINS}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Unable to fetch assets (${response.status})`);
    }

    const payload = await response.json();
    const assets = Array.isArray(payload.data) ? payload.data : [];
    cachedCoins = assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        symbol: asset.symbol.toUpperCase(),
    }));
    return cachedCoins;
}

function resolveInterval(days) {
    if (days <= 7) return 'm30';
    if (days <= 14) return 'h1';
    if (days <= 30) return 'h2';
    if (days <= 90) return 'h6';
    return 'd1';
}

function getRange(days) {
    const end = Date.now();
    const start = end - (days * 24 * 60 * 60 * 1000);
    return { start, end };
}

async function fetchMarketChart(coinId, days) {
    const { start, end } = getRange(days);
    const interval = resolveInterval(days);
    const url = new URL(`${API_BASE}/assets/${coinId}/history`);
    url.searchParams.set('interval', interval);
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);

    const response = await fetch(url.toString());
    if (!response.ok) {
        throw new Error(`Failed to fetch history for ${coinId}`);
    }

    const payload = await response.json();
    return Array.isArray(payload.data) ? payload.data : [];
}

function calculateRSI(prices, period) {
    if (prices.length <= period) {
        return [];
    }

    const gains = [];
    const losses = [];

    for (let i = 1; i < prices.length; i += 1) {
        const change = prices[i] - prices[i - 1];
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? Math.abs(change) : 0);
    }

    let avgGain = gains.slice(0, period).reduce((acc, value) => acc + value, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((acc, value) => acc + value, 0) / period;

    const rsiValues = new Array(prices.length).fill(null);

    for (let i = period; i < prices.length; i += 1) {
        if (i > period) {
            const gain = gains[i - 1];
            const loss = losses[i - 1];
            avgGain = ((avgGain * (period - 1)) + gain) / period;
            avgLoss = ((avgLoss * (period - 1)) + loss) / period;
        }

        if (avgLoss === 0) {
            rsiValues[i] = avgGain === 0 ? 50 : 100;
            continue;
        }

        const relativeStrength = avgGain / avgLoss;
        rsiValues[i] = 100 - (100 / (1 + relativeStrength));
    }

    return rsiValues;
}

function prepareDataset(coin, history, period) {
    const cleaned = history.filter((entry) => {
        if (!entry || entry.priceUsd == null || entry.time == null) {
            return false;
        }

        const price = Number(entry.priceUsd);
        const time = Number(entry.time);
        return Number.isFinite(price) && Number.isFinite(time);
    });

    const closes = cleaned.map((entry) => Number(entry.priceUsd));
    const timestamps = cleaned.map((entry) => Number(entry.time));
    const rsi = calculateRSI(closes, period);

    const points = timestamps.map((ts, index) => ({ x: ts, y: rsi[index] ?? null }));

    return {
        label: `${coin.symbol}`,
        coinName: coin.name,
        data: points,
    };
}

function updateChart(datasets, emptyMessage = 'No RSI data available for the selected range. Try increasing the number of days.') {
    const nonEmpty = datasets.filter((dataset) => dataset.data.some((point) => point.y !== null));

    if (nonEmpty.length === 0) {
        if (rsiChart) {
            rsiChart.destroy();
            rsiChart = null;
        }
        setStatus('No RSI data available for the selected range. Try increasing the number of days.');
        return false;
    }

    const chartData = nonEmpty.map((dataset, index) => ({
        label: `${dataset.label} — ${dataset.coinName}`,
        data: dataset.data,
        borderColor: palette[index % palette.length],
        backgroundColor: palette[index % palette.length],
        tension: 0.2,
        spanGaps: true,
        pointRadius: 0,
        borderWidth: 2,
    }));

    if (rsiChart) {
        rsiChart.destroy();
    }

    rsiChart = new Chart(chartCanvas, {
        type: 'line',
        data: {
            datasets: chartData,
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            parsing: false,
            scales: {
                x: {
                    type: 'time',
                    time: {
                        tooltipFormat: 'MMM d, yyyy HH:mm',
                        displayFormats: {
                            hour: 'MMM d HH:mm',
                            day: 'MMM d',
                        },
                    },
                    ticks: {
                        color: 'rgba(226, 232, 240, 0.8)',
                    },
                    grid: {
                        color: 'rgba(148, 163, 184, 0.1)',
                    },
                },
                y: {
                    suggestedMin: 0,
                    suggestedMax: 100,
                    ticks: {
                        stepSize: 10,
                        color: 'rgba(226, 232, 240, 0.8)',
                    },
                    grid: {
                        color: 'rgba(148, 163, 184, 0.1)',
                    },
                },
            },
            plugins: {
                legend: {
                    labels: {
                        color: 'rgba(226, 232, 240, 0.9)',
                        font: {
                            size: 12,
                        },
                        boxWidth: 12,
                    },
                },
                tooltip: {
                    callbacks: {
                        title(items) {
                            if (!items.length) return '';
                            const date = new Date(items[0].parsed.x);
                            return date.toLocaleString();
                        },
                        label(context) {
                            const value = context.parsed.y;
                            if (value == null) return `${context.dataset.label}: n/a`;
                            return `${context.dataset.label}: ${value.toFixed(2)}`;
                        },
                    },
                },
            },
        },
    });
    return true;
}

function setStatus(message) {
    statusEl.textContent = message;
}

async function loadData({ forceRefresh = false } = {}) {
    if (isLoading) {
        loadQueued = true;
        queueForceRefresh = queueForceRefresh || forceRefresh;
        return;
    }

    isLoading = true;
    if (forceRefresh) {
        cachedCoins = [];
        historyCache.clear();
    }

    const period = Number(periodSelect.value);
    const range = Number(rangeSelect.value);

    try {
        const coins = await fetchTopCoins();
        if (coins.length === 0) {
            updateChart([], 'No coins available to chart at the moment.');
        } else {
            setStatus(`Fetching market data for ${coins.length} coins…`);
        }

        const datasets = [];
        for (const coin of coins) {
            try {
                const history = await fetchMarketChart(coin.id, range);
                datasets.push(prepareDataset(coin, history, period));
            } catch (error) {
                console.error(error);
            }
        }

            // Gentle delay to stay within public rate limits.
            await delay(150);
        }

        const hasData = updateChart(datasets);
        if (hasData) {
            setStatus(`Showing RSI for ${datasets.length} coins. Period: ${period}. Range: ${range} days.`);
        }
    } catch (error) {
        console.error(error);
        setStatus('Something went wrong while loading the data. Please try again later.');
    } finally {
        isLoading = false;
    }

    if (loadQueued) {
        const shouldForce = queueForceRefresh;
        loadQueued = false;
        queueForceRefresh = false;
        await loadData({ forceRefresh: shouldForce });
    }
}

refreshButton.addEventListener('click', async () => {
    setStatus('Refreshing data…');
    await loadData({ forceRefresh: true });
});

periodSelect.addEventListener('change', async () => {
    setStatus('Updating RSI…');
    await loadData();
});

rangeSelect.addEventListener('change', async () => {
    setStatus('Updating RSI…');
    await loadData({ forceRefresh: true });
});

setStatus('Loading…');
loadData({ forceRefresh: true });
