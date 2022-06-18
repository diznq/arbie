const fs = require("fs")
const FEE = 0.999

class OrderBook {
    constructor(name, append=false){
        this.name = name
        this.buy = {}
        this.sell = {}
        this.append = append
        this.fs = null
        if(append){
            this.fs = fs.createWriteStream("streams/" + name + ".bin", {
                flags: "a"
            })
        }
    }

    serialize(){
        const buy = this.getBuy()
        const sell = this.getSell()
        const time = Date.now()
        const buffer = Buffer.alloc(8 + 4 + 4 + buy.length * 8 + sell.length * 8)
        buffer.writeDoubleLE(time, 0)
        buffer.writeUint32LE(buy.length * 8, 8)
        buffer.writeUint32LE(sell.length * 8, 12)
        let off = 16;
        for(let i=0; i<buy.length; i++, off+=8){
            buffer.writeFloatLE(parseFloat(buy[i][0]), off)
            buffer.writeInt32LE(parseInt(buy[i][1]), off+4)
        }
        for(let i=0; i<sell.length; i++, off+=8){
            buffer.writeFloatLE(parseFloat(sell[i][0]), off)
            buffer.writeInt32LE(parseInt(sell[i][1]), off+4)
        }
        return buffer
    }

    update(buy, sell, sync=false){
        const a = sell || []
        const b = buy || []
        if(sync){
            this.buy={};
            this.sell={};
        }
        b.forEach(el => {
            if(parseFloat(el[1]) <= 0){
                delete this.buy[el[0]]
            } else {
                this.buy[el[0]] = parseFloat(el[1])
            }
        })
        a.forEach(el => {
            if(parseFloat(el[1]) <= 0){
                delete this.sell[el[0]]
            } else {
                this.sell[el[0]] = parseFloat(el[1])
            }
        })
        if(this.fs){
            this.fs.write(this.serialize())
        }
    }

    getBuy(){
        const keys = Object.keys(this.buy)
        keys.sort((a, b) => parseFloat(b) - parseFloat(a))
        if(keys.length == 0) return [];
        return keys.map((val) => [val, this.buy[val]])
    }

    getBuyTop(){
        return this.getBuy()[0][0]
    }

    getSell(){
        const keys = Object.keys(this.sell)
        keys.sort((a, b) => parseFloat(a) - parseFloat(b))
        if(keys.length == 0) return [];
        return keys.map((val) => [val, this.sell[val]])
    }

    getSellTop(){
        return this.getSell()[0][0]
    }
}

class Assets {
    constructor(){
        this.assets = {}
    }

    deposit(asset, amount){
        this.assets[asset] = (this.assets[asset] || 0) + amount
    }

    withdraw(asset, amount){
        this.assets[asset] = (this.assets[asset] || 0) - amount
    }

    /**
     * Buy
     * @param {OrderBook} orderBook 
     */
     buy(orderBook, asset, base, amount){
        let b = orderBook.getSell()
        this.assets[base] = this.assets[base] || 0
        this.assets[asset] = this.assets[asset] || 0
        for(let i=0; i < b.length && this.assets[base] > 0; i++){
            let price = parseFloat(b[i][0])
            let total = Math.min(this.assets[base], price * parseFloat(b[i][1]))
            let amt = total / price
            //console.log(`Buy ${amt} ${asset} for ${amt * price} ${base} (xchg: ${price})`)
            this.deposit(asset, amt * FEE)
            this.withdraw(base, amt * price)
        }
    }

    /**
     * Sell
     * @param {OrderBook} orderBook 
     */
    sell(orderBook, asset, base){
        let b = orderBook.getBuy()
        this.assets[base] = this.assets[base] || 0
        this.assets[asset] = this.assets[asset] || 0
        for(let i=0; i < b.length && this.assets[asset] > 0; i++){
            let price = b[i][0]
            let amt = Math.min(this.assets[asset], b[i][1])
            //console.log(`Sell ${amt} ${asset} for ${amt * price} ${base} (xchg: ${price})`)
            this.deposit(base, amt * price * FEE)
            this.withdraw(asset, amt)
        }
    }
}

module.exports = {
    OrderBook, Assets
}