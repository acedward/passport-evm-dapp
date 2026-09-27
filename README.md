# Passport EVM dApp

A bank-style web app for opening and using Passport accounts on Midnight with an EVM wallet.

## What this is

A customer with only an EVM wallet (MetaMask or any EIP-1193 wallet) can:

1. **Open an account.** Connect the wallet and open a Passport account on Midnight with one signature. The wallet is the account's key; no Midnight wallet is needed.
2. **See holdings.** See the tokens held on Sepolia and in the Passport account, side by side, like a bank statement.
3. **Bridge both ways.** Move tokens from Sepolia into the Passport account on Midnight, and back out to any Sepolia address.
4. **See prices.** See the USDC price of each tokenised stock, taken only from the live ZSwap offer book. A pair with no live offers shows "no liquidity".
5. **Buy and sell.** Trade a stock against USDC by making an offer at a chosen price, or by taking an offer already in the book.
6. **Keep data in the browser.** Everything the dApp stores about a customer stays in the browser. A Local data tab shows it and offers Export, Import and Clear all.

## Architecture

- **Web app**: a static site. It connects the EVM wallet, holds the customer's records in local storage, and computes balances and prices in the browser.
- **Relay**: a stateless service. It proves each transaction, pays the Midnight fees from a sponsor wallet, and drives bridge requests to completion. It stores nothing about individual customers.
- **Networks**: Midnight stagenet and Ethereum Sepolia. Both are test networks; nothing here carries real value.

## How this branch works

`00039-passport-evm-dapp` is the master branch of this project's single pull request into `main`. Work is done on short-lived branches whose temporary pull requests target this branch, and each is merged in with a merge commit once its checks are green. The master pull request stays a draft until the work is complete.
