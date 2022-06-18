# Arbie
Arbitrage/Swap bot for Binance

## Set-up
1. Create `state.json` file based on `state.template.json` and set values according your current account state and tokens you want to swap between
2. Create `env.json` file with following contents
```
{
    "CCY" : "USDT",
    "ACTIVE" : "true",
    "REST_API_TOKEN" : "SECRET",
    "BINANCE_API_SECRET" : "SECRET",
    "BINANCE_API_KEY" : "SECRET"
}
```
3. Run `docker build . -t arbie:latest`
4. Run `docker run -p 8000:8000 --expose=8000 --name arbie -d arbie:latest`
5. Connect to `http://localhost:8000/trader/ui`

## Tips
Before destroying Docker container, make sure to backup `/trader/state?token=REST_API_TOKEN` to your local `state.json` so it can be reused in next build and no information about last state is lost

### State.json pairs entries
Let's have example of such entry being
```
"SOL" : {
    "symbol" : "SOLUSDT",
    "SOL": 10,
    "USDT": 100
}
```
- Symbol always represents token pair, it's not always TOKENUSDT, sometimes it can be USDTTOKEN, therefore it must be specified by user
- SOL: 10, we can buy Solana with max 10 points of precision, i.e. 69.4 SOL, but not 69.42 SOL
- USDT: 100, we can sell USDT to buy Solana with max 100 points of precision, i.e. 69.42 USDT for 1 SOL, but not for 69.421 USDT for 1 SOL

If a token is currency, use `"symbol": null` with `"fiat": true` as properties.