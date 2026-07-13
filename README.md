# Base SDK
This is the SDK for Privacy Cash on Base. For documentation, please check: https://privacycash.mintlify.app/basesdk/frontend

The SDK also supports BNB mainnet native BNB through `BNB_NETWORK` (chain ID
56). Pass `token: 'bnb'` explicitly, or omit `token` when `network` is
`BNB_NETWORK`. BNB USDT is not supported yet.

Run `bun example/bnb-bnb.ts balance` for the BNB SDK example. Deposit and
withdraw actions require an amount and `BNB_PRIVATE_KEY`. The Base and Ethereum
examples continue to use `PRIVATE_KEY`.

### Disclaimer
This SDK powers Privacy Cash's frontend, assuming the single wallet use case. It is NOT supposed to support hardware wallet.

If you use it or published npm library from this repo, please fully test and beware of the inherent software risks or potential bugs. Our team is not responsible for any losses.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
