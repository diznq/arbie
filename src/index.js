const { OrderBook, Assets } = require("./orderbook")
const Binance = require("binance-api-node").default
const request = require("request")
const fs = require("fs")
const express = require("express")
const state = require("../state.json")
const env = process.env

if (fs.existsSync("env.json")) {
    const localEnv = JSON.parse(fs.readFileSync("env.json"))
    for (const key in localEnv) {
        if (Object.hasOwnProperty.call(localEnv, key)) {
            const element = localEnv[key];
            if (typeof (env[key]) == "undefined")
                env[key] = element;
        }
    }
}

if (!env.BINANCE_API_KEY || !env.BINANCE_API_SECRET) {
    console.error("Define BINANCE_API_KEY and BINANCE_API_SECRET as environment variable or in env.json")
    process.exit(1)
}

const COLLECT = (env.COLLECT || "false").toString() == "true"
const CCY = env.CCY || "USDT"
const OFFSET = parseFloat(env.OFFSET || "1")
const bullrunBarrier = parseFloat(env.BULLRUN_BARRIER || "0")
const bearrunBarrier = parseFloat(env.BEARRUN_BARRIER || "0")
let ROI = parseFloat(env.ROI || "1.15")
let VROI = parseFloat(env.VROI || "1.00")
let VROI_MAX = parseFloat(env.VROI_MAX || "1.0")

function getROI(timeSinceLastTrade) {
    let Minutes = Math.max(1440, timeSinceLastTrade / 60000)
    let VROIc = Math.pow(VROI, Minutes / 1440)
    if (VROIc > VROI_MAX && VROI_MAX > 1) VROIc = VROI_MAX
    return (ROI - 1 + VROIc)
}

async function getDepth(symbol) {
    return new Promise((resolve) => {
        request.get("https://api.binance.com/api/v3/depth?symbol=" + symbol + "&limit=1000", (e, resp, body) => {
            const obj = JSON.parse(body)
            return resolve(obj)
        })
    })
}

async function waitForOrder(client, res) {
    while (res.status != "FILLED") {
        res = await client.getOrder({
            orderId: res.orderId
        })
    }
    return res
}

async function doOrder(client, spec) {
    console.log("Order", spec)
    return await client.order(spec)
}

async function updateBalances(client, state, assetNow) {
    const info = await client.accountInfo()
    info.balances.forEach(balance => {
        state.balances[balance.asset] = parseFloat(balance.free)
        if (assetNow != null && balance.asset == assetNow) {
            state.track[assetNow] = Math.max(state.track[assetNow], state.balances[assetNow])
        }
    })
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2))
}

async function main() {
    const app = express()
    app.use(express.json())
    app.use("/trader/ui/", express.static(__dirname + "/../static"))

    if (typeof (state.lastTrade) != "number") {
        state.lastTrade = Date.now()
    }

    let sseClients = []
    let sseCtr = 0
    let topSecret = env.REST_API_TOKEN
    let isActive = (env.ACTIVE || "true").toString() == "true"

    function ssePublish(msg) {
        sseClients.forEach(cli => cli.cli.write(`data:${JSON.stringify(msg)}\n\n`))
    }


    for (const key in state.pairs) {
        if (Object.hasOwnProperty.call(state.pairs, key)) {
            const element = state.pairs[key];
            if (typeof (element) == "string" || element == null) {
                let obj = { symbol: element }
                obj[key] = 100
                obj[CCY] = 100
                state.pairs[key] = obj
            }
        }
    }

    let noTrades = 0
    let maxTrades = 1000

    /**
     * @type {{[key: string]: OrderBook}}
     */
    const obs = {}
    const symbols = []
    for (const key in state.pairs) {
        if (Object.hasOwnProperty.call(state.pairs, key)) {
            const element = state.pairs[key].symbol;
            if (element == null) continue;
            obs[element] = new OrderBook(element, COLLECT)
            symbols.push(element)
        }
    }

    const client = Binance({
        apiKey: env.BINANCE_API_KEY,
        apiSecret: env.BINANCE_API_SECRET
    })


    async function syncOrderbooks() {
        let awaits = []
        for (let i = 0; i < symbols.length; i++) {
            awaits.push(getDepth(symbols[i]).then(obj => {
                obs[symbols[i]].update(obj.bids, obj.asks, true)
            }))
        }
        await Promise.all(awaits)
    }

    await syncOrderbooks()

    let processing = false
    let returns = {}
    let ratios = {}

    let reconnect = false;
    let reconnecting = false;
    let afterSell = false;

    function getPubObj() {
        return {
            holding: state.holding,
            track: state.track,
            equity: returns,
            returns: ratios
        }
    }

    function connect() {
        reconnect = false;
        reconnecting = false;
        let closeHandle = client.ws.depth(symbols.map(sym => sym + "@100ms"), async (depth) => {
            if (reconnect) {
                closeHandle()
                if (!reconnecting) {
                    reconnecting = true;
                    setTimeout(connect, 500)
                }
                return;
            }
            try {
                const symbol = depth.symbol
                const ob = obs[symbol]
                if (typeof (ob) == "undefined") return;
                ob.update(
                    depth.bidDepth.map(a => [a.price, a.quantity]),
                    depth.askDepth.map(a => [a.price, a.quantity]),
                )
                const assets = new Assets()
                const toEUROb = obs[state.pairs[state.holding].symbol]
                const selling = state.holding == CCY || state.pairs[state.holding].symbol.endsWith(CCY)
                assets.deposit(state.holding, state.balances[state.holding])
                if (state.holding != CCY) {
                    if (selling) {
                        assets.sell(toEUROb, state.holding, CCY)
                    } else {
                        assets.buy(toEUROb, CCY, state.holding)
                    }
                }
                const MainCCY = assets.assets[CCY]
                const RROI = getROI(Date.now() - state.lastTrade)
                let bestDeal = 0, bestDealCoin = null, newHoldings = 0;

                for (const key in state.track) {
                    if (Object.hasOwnProperty.call(state.track, key)) {
                        const last = state.track[key];
                        let newAmount = 0
                        if (key == CCY) {
                            newAmount = MainCCY
                        } else {
                            const soughtOb = obs[state.pairs[key].symbol]
                            const newSelling = state.pairs[key].symbol.endsWith(CCY)
                            const newAssets = new Assets()
                            newAssets.deposit(CCY, MainCCY)
                            if (newSelling) {
                                newAssets.buy(soughtOb, key, CCY)
                            } else {
                                newAssets.sell(soughtOb, CCY, key)
                            }
                            newAmount = newAssets.assets[key]
                        }
                        let ratio = newAmount * OFFSET / last
                        let canPerformLocal = true
                        let holdingFiat = state.pairs[state.holding].fiat || false
                        let eyeingFiat = state.pairs[key].fiat || false

                        if (afterSell) {
                            ratio = 1.0;
                            canPerformLocal = false;
                            state.track[key] = Math.max(state.track[key], newAmount)
                        }

                        if (holdingFiat && !eyeingFiat && ratio < (RROI + bearrunBarrier)) canPerformLocal = false;
                        else if (!holdingFiat && eyeingFiat && ratio < (RROI + bullrunBarrier)) canPerformLocal = false;
                        else if (key == state.holding) canPerformLocal = false;
                        if (ratio > bestDeal && canPerformLocal) {
                            bestDeal = ratio
                            bestDealCoin = key
                            newHoldings = newAmount
                        }
                        ratios[key] = ratio
                        returns[key] = newAmount * OFFSET
                    }
                }
                if (afterSell) {
                    afterSell = false;
                    fs.writeFileSync("state.json", JSON.stringify(state, null, 2))
                }
                ssePublish(getPubObj())
                //console.log(returns)
                if (bestDeal >= RROI && !afterSell && isActive) {
                    if (processing) return;
                    console.log("Best deal is ", bestDealCoin, "old holdings: ", state.track[bestDealCoin], "new holdings: ", newHoldings, "active: ", processing, "rroi: ", RROI)
                    if (noTrades >= maxTrades) return;
                    //return;
                    processing = true;
                    state.lastTrade = Date.now()
                    if (bestDealCoin == CCY) {
                        let spec = state.pairs[state.holding]
                        let symbol = spec.symbol
                        let action = symbol.endsWith(CCY) ? "SELL" : "BUY"
                        let precision = spec[action == "SELL" ? state.holding : CCY]
                        let orderQty = action == "SELL" ? (state.balances[state.holding]) : newHoldings
                        let res = await doOrder(client, {
                            type: "MARKET",
                            symbol: symbol,
                            side: action,
                            quantity: Math.floor(orderQty * precision) / precision
                        })
                        res = await waitForOrder(client, res)
                        state.holding = CCY
                        await updateBalances(client, state, CCY)
                        console.log("Total currency after sell: ", state.balances[CCY])
                        afterSell = true;
                        //console.log("Sell for currency result: ", res)
                    } else {
                        let res = state.track[CCY];
                        // Sell for currency if possible
                        if (state.holding != CCY) {
                            let spec = state.pairs[state.holding]
                            let symbol = spec.symbol
                            let action = symbol.endsWith(CCY) ? "SELL" : "BUY"
                            let precision = spec[action == "SELL" ? state.holding : CCY]
                            let orderQty = action == "SELL" ? state.balances[state.holding] : assets.assets[CCY]
                            let res = await doOrder(client, {
                                type: "MARKET",
                                symbol: symbol,
                                side: action,
                                quantity: Math.floor(orderQty * precision) / precision
                            })
                            res = await waitForOrder(client, res)
                            state.holding = CCY
                            await updateBalances(client, state, CCY)
                            console.log("Total currency after sell: ", state.balances[CCY])
                            //console.log("Sell for currency result: ", res)
                        }
                        // Buy with main currency
                        {
                            let spec = state.pairs[bestDealCoin]
                            let symbol = spec.symbol
                            let action = symbol.endsWith(CCY) ? "BUY" : "SELL"
                            let precision = spec[action == "BUY" ? bestDealCoin : CCY]
                            let orderQty = (action == "BUY" ? newHoldings : state.balances[CCY]) * OFFSET

                            res = await doOrder(client, {
                                type: "MARKET",
                                symbol: symbol,
                                side: action,
                                quantity: Math.floor(orderQty * precision) / precision
                            })

                            res = await waitForOrder(client, res)
                            state.holding = bestDealCoin
                            await updateBalances(client, state, state.holding)
                            console.log("Total " + state.holding + " balance after buy: ", state.balances[state.holding])
                            afterSell = true;
                        }
                    }
                    noTrades++;
                    processing = false;
                }
            } catch (ex) {
                console.error(ex)
                processing = false;
            }
            //console.log(symbol, ob.getBuyTop(), ob.getSellTop())
        })
    }

    app.get("/trader/roi", (req, res) => {
        if ((req.query.token || "") !== topSecret) return res.send({ error: "invalid auth token" })
        ROI = parseFloat(req.query.roi || ROI)
        VROI = parseFloat(req.query.vroi || VROI)
        VROI_MAX = parseFloat(req.query.vroim || VROI_MAX)
        res.send({ ROI: ROI, VROI: VROI, VROI_MAX: VROI_MAX, RealROI: getROI(Date.now() - state.lastTrade) })
    })

    app.get("/trader/trades", (req, res) => {
        if ((req.query.token || "") !== topSecret) return res.send({ error: "invalid auth token" })
        maxTrades = parseFloat(req.query.max || maxTrades)
        res.send({ max: maxTrades })
    })

    app.get("/trader/state", (req, res) => {
        if ((req.query.token || "") !== topSecret) return res.send({ error: "invalid auth token" })
        res.send(state)
    })

    app.get("/trader/active/:state", (req, res) => {
        if ((req.query.token || "") !== topSecret) return res.send({ error: "invalid auth token" })
        isActive = req.params.state != "0"
        res.send({ active: isActive })
    })

    app.post("/trader/asset/:asset", async (req, res) => {
        if ((req.query.token || "") !== topSecret) return res.send({ error: "invalid auth token" })
        const name = req.params.asset
        const holding = req.body.track || req.body.holding || 0
        const pair = req.body.pair;
        if (typeof (pair) == "undefined" || holding == 0) {
            return res.send({ error: "provide track and pair" })
        }
        const symbol = pair.symbol
        const depth = await getDepth(symbol)
        const ob = new OrderBook(symbol, COLLECT)
        ob.update(depth.bids, depth.asks)
        obs[symbol] = ob;
        reconnect = true;
        symbols.push(symbol)
        state.track[name] = parseFloat(holding)
        state.pairs[name] = pair
        fs.writeFileSync("state.json", JSON.stringify(state))
        res.send(state)
    })

    app.get("/trader/sse", (req, res) => {
        const headers = {
            "Content-Type": "text/event-stream",
            "Connection": "keep-alive",
            "Cache-Control": "no-cache"
        };
        const idNow = ++sseCtr
        res.writeHead(200, headers);
        sseClients.push({ id: idNow, cli: res })

        res.write(`data:${JSON.stringify(getPubObj())}\n\n`)

        req.on("close", () => {
            sseClients = sseClients.filter(cli => cli.id !== idNow)
        })
    })

    updateBalances(client, state, null)

    setInterval(() => {
        syncOrderbooks()
    }, 300 * 1000)

    connect()
    app.listen(8000)
}

main()