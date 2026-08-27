# Base SDK
This is the SDK for Privacy Cash on Base. For documentation, please check: https://privacycash.mintlify.app/basesdk/frontend

The SDK also supports BNB mainnet native BNB and USDT through `BNB_NETWORK`
(chain ID 56). Pass `token: 'bnb'` explicitly (or omit `token`) for native BNB,
and pass `token: 'usdt'` for BNB USDT.

Run `bun example/bnb-bnb.ts balance` or `bun example/bnb-usdt.ts balance` for
the BNB SDK examples. Deposit and withdraw actions require an amount and
`BNB_PRIVATE_KEY`. The Base and Ethereum examples continue to use `PRIVATE_KEY`.

Robinhood Chain mainnet supports native ETH and USDG through
`ROBINHOOD_NETWORK` (chain ID 4663). Native ETH is the default; pass
`token: 'usdg'` for USDG. SDK reads use the EVM indexer's
`/rpc/robinhood` proxy, and deposit limits are read directly from the
selected Robinhood pool contract. Run `bun example/robin-eth.ts balance` or
`bun example/robin-usdg.ts balance` for the corresponding example.

Robinhood deposits default to a 110% base-fee multiplier and zero priority
fee. Override them with `ROBINHOOD_FEE_BUMP_PERCENT` and
`ROBINHOOD_PRIORITY_FEE_GWEI`; browser builds may use the corresponding
`NEXT_PUBLIC_` variables.

# Warnings
Privacy Cash SDK requires consistent signature generation, otherwise the deposited tokens might be lost forever since the encrypted UTXO can't be decrypted. Please make sure 
deriveKeys() generates the same result for the same params passed in. Most wallets returns the same result, but some non major wallets might generate different result.

### Disclaimer
This SDK powers Privacy Cash's frontend, assuming the single wallet use case. It is NOT supposed to support hardware wallet.

If you use it or published npm library from this repo, please fully test and beware of the inherent software risks or potential bugs. Our team is not responsible for any losses.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
