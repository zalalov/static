const API_BASE = 'https://api.coingecko.com/api/v3';
const MAX_COINS = 20;
const chartCanvas = document.getElementById('rsiChart');
const periodSelect = document.getElementById('period-select');
const rangeSelect = document.getElementById('range-select');
const refreshButton = document.getElementById('refresh-btn');
const statusEl = document.getElementById('status');

let rsiChart = null;
let cachedCoins = [];
let lastApiCall = 0;

const palette = [
    '#38bdf8', '#f97316', '#facc15', '#34d399', '#a855f7', '#ec4899', '#22d3ee', '#f87171', '#c084fc', '#4ade80',
    '#60a5fa', '#fb7185', '#fbbf24', '#2dd4bf', '#818cf8', '#f472b6', '#14b8a6', '#e879f9', '#93c5fd', '#f59e0b'
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MIN_API_INTERVAL = 1250;
const PROXY_PREFIX = 'https://api.allorigins.win/raw?url=';

async function rateLimitedFetch(url, options = {}) {
    const now = Date.now();
    const elapsed = now - lastApiCall;

    if (elapsed < MIN_API_INTERVAL) {
        await delay(MIN_API_INTERVAL - elapsed);
    }

    lastApiCall = Date.now();

    try {
        return await fetch(url, options);
    } catch (error) {
        lastApiCall = Date.now();
        throw error;
    }
}

async function fetchWithCorsFallback(url, { attempts = 4, allowProxyFallback = true, options = {} } = {}) {
    let useProxy = false;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const targetUrl = useProxy
            ? `${PROXY_PREFIX}${encodeURIComponent(url.includes('?') ? `${url}&_=${Date.now()}` : `${url}?_=${Date.now()}`)}`
            : url;
        try {
            const response = await rateLimitedFetch(targetUrl, {
                ...options,
                headers: {
                    Accept: 'application/json',
                    ...(options.headers || {}),
                },
            });

            if (response.ok) {
                return response;
            }

            if (response.status === 429 && attempt < attempts) {
                const jitter = Math.random() * 400;
                const backoff = 900 * attempt + jitter;
                await delay(backoff);
                continue;
            }

            if (
                allowProxyFallback &&
                !useProxy &&
                (response.status === 403 || response.status === 429 || response.status === 0)
            ) {
                useProxy = true;
                attempt -= 1;
                await delay(700);
                continue;
            }

            throw new Error(`Request to ${url} failed with status ${response.status}`);
        } catch (error) {
            lastError = error;

            if (
                allowProxyFallback &&
                !useProxy &&
                (error instanceof TypeError ||
                    (typeof error.message === 'string' &&
                        (error.message.includes('Failed to fetch') || error.message.includes('NetworkError'))))
            ) {
                useProxy = true;
                attempt -= 1;
                await delay(700);
                continue;
            }

            if (attempt >= attempts) {
                throw lastError;
            }

            const fallbackDelay = 1200 * attempt;
            await delay(fallbackDelay);
        }
    }

    throw lastError || new Error(`Request to ${url} failed`);
}

async function fetchTopCoins() {
    if (cachedCoins.length > 0) {
        return cachedCoins;
    }

    setStatus('Fetching top cryptocurrencies…');
    const url = `${API_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${MAX_COINS}&page=1&sparkline=false`;
    const response = await fetchWithCorsFallback(url, { attempts: 4, options: {} });
    const data = await response.json();
    cachedCoins = data.map((coin) => ({ id: coin.id, name: coin.name, symbol: coin.symbol.toUpperCase() }));
    return cachedCoins;
}

async function fetchMarketChart(coinId, days) {
    const interval = days > 30 ? 'daily' : 'hourly';
    const url = `${API_BASE}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=${interval}`;
    const response = await fetchWithCorsFallback(url, {
        attempts: 5,
        options: {},
    });
    return response.json();
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

function prepareDataset(coin, chartData, period) {
    const { prices } = chartData;

    if (!Array.isArray(prices) || prices.length === 0) {
        return null;
    }

    const closes = prices.map(([, value]) => value);
    const timestamps = prices.map(([ts]) => ts);
    const rsi = calculateRSI(closes, period);

    const points = timestamps.map((ts, index) => ({ x: ts, y: rsi[index] ?? null }));
    const hasValues = points.some((point) => Number.isFinite(point.y));

    if (!hasValues) {
        return null;
    }

    return {
        label: `${coin.symbol}`,
        coinName: coin.name,
        data: points,
    };
}

function updateChart(datasets) {
    const nonEmpty = datasets.filter((dataset) => dataset.data.some((point) => Number.isFinite(point.y)));

    if (nonEmpty.length === 0) {
        setStatus('No RSI data available for the selected range. Try increasing the number of days.');
        return 0;
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
    return nonEmpty.length;
}

function setStatus(message) {
    statusEl.textContent = message;
}

async function loadData() {
    const period = Number(periodSelect.value);
    const range = Number(rangeSelect.value);

    try {
        const coins = await fetchTopCoins();
        setStatus(`Fetching market data for ${coins.length} coins…`);

        const datasets = [];
        const failures = [];
        const insufficientData = [];
        for (const [index, coin] of coins.entries()) {
            try {
                const marketChart = await fetchMarketChart(coin.id, range);
                const dataset = prepareDataset(coin, marketChart, period);
                if (dataset) {
                    datasets.push(dataset);
                } else {
                    insufficientData.push(coin.name);
                }
            } catch (error) {
                console.error(error);
                failures.push(coin.name);
            }

            if ((index + 1) % 3 === 0 || index === coins.length - 1) {
                const readyToChart = datasets.length;
                const progressSuffix = readyToChart ? ` (${readyToChart} ready to chart)` : '';
                setStatus(`Fetched history for ${index + 1} of ${coins.length} coins…${progressSuffix}`);
            }

            // Ensure a small pause between sequential requests.
            if (index < coins.length - 1) {
                await delay(300);
            }
        }

        const displayedCount = updateChart(datasets);
        if (displayedCount > 0) {
            const suffixParts = [];
            if (failures.length) {
                suffixParts.push(`${failures.length} failed: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? ', …' : ''}`);
            }
            if (insufficientData.length) {
                suffixParts.push(`${insufficientData.length} missing history: ${insufficientData.slice(0, 3).join(', ')}${insufficientData.length > 3 ? ', …' : ''}`);
            }

            const suffix = suffixParts.length ? ` (${suffixParts.join(' | ')})` : '';
            setStatus(`Showing RSI for ${displayedCount} coins. Period: ${period}. Range: ${range} days.${suffix}`);
        } else {
            if (failures.length === coins.length) {
                setStatus('Unable to load RSI data right now due to API limits. Please try refreshing in a moment.');
            } else {
                const reasons = [];
                if (insufficientData.length) {
                    reasons.push(`No recent history for ${insufficientData.slice(0, 3).join(', ')}${insufficientData.length > 3 ? ', …' : ''}.`);
                }
                if (failures.length) {
                    reasons.push(`Requests failed for ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? ', …' : ''}.`);
                }
                const fallbackMessage = reasons.length
                    ? `Unable to render RSI data. ${reasons.join(' ')}`
                    : 'No RSI data available for the selected range. Try increasing the number of days.';
                setStatus(fallbackMessage);
            }
        }
    } catch (error) {
        console.error(error);
        setStatus('Something went wrong while loading the data. Please try again later.');
    }
}

refreshButton.addEventListener('click', () => {
    setStatus('Refreshing data…');
    loadData();
});

periodSelect.addEventListener('change', () => {
    setStatus('Updating RSI…');
    loadData();
});

rangeSelect.addEventListener('change', () => {
    setStatus('Updating RSI…');
    loadData();
});

setStatus('Loading…');
loadData();
