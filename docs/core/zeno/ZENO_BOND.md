<h1>ZENO — Zero-Coupon External-Market Note Operations System</h1>

<h2>Overview</h2>

<p>ZENO is a generic zero-coupon bond primitive. The same contract pair (<code>ZENO</code> + <code>Auction</code>) parameterizes into very different products by varying the underlying, the payment token, the price curve, and the funding mode. The mechanic itself is uniform; the choice of parameters determines what kind of product you ship.</p>

<p>A ZENO holder may redeem 1 ZENO smallest-unit for 1 <code>underlyingAsset</code> smallest-unit at or after <code>MATURITY_DATE</code>. ZENO inherits its decimals from the underlying, so the redemption ratio is unit-for-unit.</p>

<h2>The Three Roles</h2>

<table>
  <tr><th>Role</th><th>What it is</th><th>Where it lives</th></tr>
  <tr><td><strong>Underlying</strong></td><td>The asset 1 ZENO redeems for at maturity (1:1)</td><td><code>ZENO.underlyingAsset</code> (immutable)</td></tr>
  <tr><td><strong>Payment token</strong></td><td>The asset bidders pay during the auction</td><td><code>Auction.token</code> (immutable)</td></tr>
  <tr><td><strong>Auction price</strong></td><td>How many payment-token units (smallest-units) it costs to buy 1 <em>whole</em> ZENO</td><td><code>Auction.getPrice()</code></td></tr>
</table>

<p>These three are decoupled. Decimals of the payment token may differ from decimals of the underlying. Price is denominated in <em>payment-token smallest-units per whole ZENO</em>.</p>

<h2>Funding Modes</h2>

<p>Set at deploy on the <code>Auction</code> via the <code>FundingMode</code> enum:</p>

<table>
  <tr><th>Mode</th><th>What happens</th><th>Constraint at deploy</th></tr>
  <tr><td><code>Prefilled</code></td><td>The issuer deposits the full <code>totalAllocated</code> of underlying into the ZENO contract <em>before</em> the auction. ZENO is fully backed from day one. Bidders' payments flow to the issuer as revenue / funding cost.</td><td><code>underlying.balanceOf(zeno) &gt;= totalAllocated</code> — checked in <code>Auction</code> constructor.</td></tr>
  <tr><td><code>Float</code></td><td>The issuer takes the auction proceeds and may deploy them (yield strategy, RWA acquisition, AMO, etc.). They must top up the ZENO contract with underlying before maturity, or redemptions revert via the solvency check.</td><td>None at deploy. Solvency is enforced lazily by <code>ZENO._redeem</code>'s <code>balance &gt;= totalSupply</code> check.</td></tr>
</table>

<h2>Product Variants — same contracts, different parameters</h2>

<table>
  <tr>
    <th>Product shape</th>
    <th><code>underlyingAsset</code></th>
    <th><code>token</code> (payment)</th>
    <th><code>startingPrice</code></th>
    <th><code>reservePrice</code></th>
    <th><code>fundingMode</code></th>
    <th><code>issuer</code></th>
  </tr>
  <tr>
    <td>Discounted stablecoin bond</td>
    <td>stablecoin A</td>
    <td>stablecoin B</td>
    <td>discount (fixed)</td>
    <td>= startingPrice</td>
    <td>Prefilled or Float</td>
    <td>treasury</td>
  </tr>
  <tr>
    <td>RWA-backed investment bond</td>
    <td>RWA-backed token</td>
    <td>stablecoin</td>
    <td>start &gt; reserve</td>
    <td>chosen floor</td>
    <td>Float</td>
    <td>strategy / acquisition vehicle</td>
  </tr>
  <tr>
    <td>Strategy-funded discount bond</td>
    <td>any par asset</td>
    <td>any payment asset</td>
    <td>discount fixed or decaying</td>
    <td>≥ 1 wei</td>
    <td>Float</td>
    <td>strategy contract</td>
  </tr>
  <tr>
    <td>Self-buy LP-seeding bond</td>
    <td>token X</td>
    <td>token X (same as underlying)</td>
    <td>1:1 (fixed)</td>
    <td>= startingPrice</td>
    <td>Prefilled</td>
    <td>same address as buyer</td>
  </tr>
  <tr>
    <td>Dutch-auction price discovery</td>
    <td>any</td>
    <td>any</td>
    <td>start &gt; reserve</td>
    <td>≥ 1 wei</td>
    <td>any</td>
    <td>any</td>
  </tr>
  <tr>
    <td>Fixed-price bond (no decay)</td>
    <td>any</td>
    <td>any</td>
    <td>start = reserve</td>
    <td>= startingPrice</td>
    <td>any</td>
    <td>any</td>
  </tr>
</table>

<p>Setting <code>startingPrice == reservePrice</code> turns the Dutch curve into a constant — a flat-priced bond. Setting <code>startingPrice &gt; reservePrice</code> gives a classic decaying Dutch auction. <code>reservePrice == 0</code> is rejected (would allow infinite ZENO per pay-wei and divide-by-zero in <code>buy()</code>).</p>

<h2>Rounding</h2>

<p>Every division in the system truncates in favor of the protocol:</p>

<ul>
  <li><code>Auction.getPrice()</code>: linear interpolation rounds the time-elapsed offset <em>down</em>, so the returned price rounds <em>up</em> vs. the exact value. Buyer pays slightly more per ZENO.</li>
  <li><code>Auction.buy()</code>: <code>zenoOut = paymentAmount * 10^D_zeno / price</code> truncates, so the buyer receives <em>at most</em> the exact ratio (never more).</li>
  <li><code>ZENO._redeem</code>: 1:1 in smallest units, no rounding.</li>
  <li><code>ZENO.sweepSurplus</code>: simple subtraction <code>balance - totalSupply</code>, no rounding.</li>
</ul>

<h2>Decimals</h2>

<p>Payment-token decimals (<code>D_pay</code>) and underlying decimals (<code>D_zeno</code>, also equal to ZENO's decimals) are independent. <code>buy()</code> scales by <code>10^D_zeno</code> regardless of <code>D_pay</code>. The price is denominated in payment-token smallest-units per whole ZENO, so a <code>0.95 USDC</code> price is <code>0.95 * 10^6 = 950000</code> regardless of what <code>D_zeno</code> is.</p>

<h2>Token Compatibility</h2>

<p><strong>Neither the payment token nor the underlying may be fee-on-transfer or rebasing.</strong></p>

<ul>
  <li><code>buy()</code> mints ZENO based on the requested <code>paymentAmount</code> (not what the issuer actually received). A fee-on-transfer payment token would let buyers receive ZENO without the issuer collecting the matching value.</li>
  <li><code>ZENO._redeem</code>'s solvency check (<code>balance &gt;= totalSupply</code>) assumes 1:1 balance/supply correspondence. A rebasing or fee-on-transfer underlying breaks both prefill and Float-mode top-up arithmetic.</li>
</ul>

<h2>Contract surface</h2>

<h3>ZENO.sol</h3>

<ul>
  <li><code>constructor(address underlying, uint256 maturityDate, string name, string symbol, address initialOwner)</code></li>
  <li><code>setAuction(address auction) external onlyOwner</code> — one-shot link to the auction; revert <code>AuctionAlreadySet</code> on re-call.</li>
  <li><code>mint(address to, uint256 amount) external onlyAuction</code> — only the linked auction can mint.</li>
  <li><code>redeem(uint256 amount) / redeemAll() external nonReentrant</code> — gated on <code>block.timestamp &gt;= MATURITY_DATE</code> and the solvency check (<code>InsufficientCollateral</code> revert).</li>
  <li><code>sweepSurplus(address to, uint256 amount) external onlyOwner</code> — gated on auction being set <em>and</em> ended; caps at <code>balance - totalSupply()</code>.</li>
  <li><code>totalMinted() external view → uint256</code> — monotonic counter (survives burns).</li>
  <li><code>getDetails() external view → ZENODetails</code> — returns <code>{address, maturityDate, name, symbol, totalMinted, totalRedeemed}</code> where <code>totalRedeemed = totalMinted - totalSupply()</code>.</li>
</ul>

<h3>Auction.sol</h3>

<p>Uses OZ <code>AccessControl</code> + <code>Pausable</code>. <code>_initialOwner</code> is granted <code>DEFAULT_ADMIN_ROLE</code> and <code>PAUSER_ROLE</code> at construction. <code>PAUSER_ROLE</code> can <code>pause()</code>; only <code>DEFAULT_ADMIN_ROLE</code> can <code>unpause()</code>. Time keeps advancing while paused.</p>

<ul>
  <li><code>constructor(address zeno, address token, address issuer, uint256 startTime, uint256 endTime, uint256 startingPrice, uint256 reservePrice, uint256 totalAllocated, FundingMode fundingMode, address initialOwner)</code> — validates: no zero addresses, <code>endTime &gt; startTime</code>, <code>reservePrice &gt; 0</code>, <code>startingPrice &gt;= reservePrice</code>, <code>zeno.MATURITY_DATE() &gt; endTime</code>, and (if Prefilled) <code>underlying.balanceOf(zeno) &gt;= totalAllocated</code>.</li>
  <li><code>pause() external onlyRole(PAUSER_ROLE)</code> / <code>unpause() external onlyRole(DEFAULT_ADMIN_ROLE)</code>.</li>
  <li><code>getPrice() public view → uint256</code> — current price in pay-small per whole ZENO.</li>
  <li><code>buy(uint256 paymentAmount, uint256 minZenoOut) external whenActive whenNotPaused nonReentrant</code> — buyer specifies the exact amount to spend and a slippage floor on the ZENO they're willing to accept. <code>safeTransferFrom(buyer, issuer, paymentAmount)</code> + <code>zeno.mint(buyer, zenoOut)</code>.</li>
  <li><code>totalRemaining() public view → uint256</code> — derived as <code>totalAllocated - zeno.totalMinted()</code>. Stays correct even after post-maturity redemptions (which decrease <code>totalSupply</code> but not <code>totalMinted</code>).</li>
  <li><code>checkAuctionEnded() external view → bool</code> — true once <code>block.timestamp &gt; endTime</code> or sold out.</li>
  <li><code>getDetails() external view → AuctionDetails</code> — full struct including the <code>FundingMode</code>.</li>
</ul>

<h3>ZENOFactory.sol</h3>

<ul>
  <li><code>createZENOContract(address tokenAddress, uint256 maturityDate, address initialOwner) external onlyOwner returns (address zeno)</code> — deploys a ZENO named <code>"ZENO Bond &lt;YYYYMMDD&gt;"</code> with symbol <code>"ZENO-&lt;YYYYMMDD&gt;"</code>, where <code>YYYYMMDD</code> is the calendar date of <code>maturityDate</code> in UTC (computed on-chain via Howard Hinnant's date algorithm). Returns the new ZENO address — composable from another contract and pre-computable off-chain via <code>staticCall</code>.</li>
  <li><code>zenos(uint256 idx) public view → ZENO</code> — auto-generated getter for the deployed-instances array.</li>
  <li><code>getZENOs() external view → ZENO[]</code> / <code>getZENOCount() external view → uint256</code>.</li>
  <li><code>isZENO(address) public view → bool</code> — O(1) authenticity check: was this address deployed by this factory? Use it from downstream contracts/integrations that should only trust canonical bonds.</li>
</ul>

<h3>AuctionFactory.sol</h3>

<ul>
  <li><code>createAuction(zeno, token, issuer, startTime, endTime, startingPrice, reservePrice, totalAllocated, fundingMode, initialOwner) external onlyOwner returns (address auction)</code> — passes all parameters through to a new <code>Auction</code> and returns its address.</li>
  <li><code>auctions(uint256 idx) public view → Auction</code> — auto-generated getter for the deployed-instances array.</li>
  <li><code>getAuctions() external view → Auction[]</code> / <code>getAuctionCount() external view → uint256</code>.</li>
  <li><code>isAuction(address) public view → bool</code> — O(1) authenticity check, symmetric with <code>ZENOFactory.isZENO</code>.</li>
</ul>

<h2>Deploying a new bond (factories already deployed)</h2>

<p>Once <code>ZENOFactory</code> and <code>AuctionFactory</code> are live on-chain, launching a new bond is a four-step sequence. Steps 1, 3, and 4 are <code>onlyOwner</code> on the relevant contract — typically the same multisig deploys both factories and owns the freshly minted ZENO, so the whole flow can run as a single multisig batch.</p>

<h3>Step 0 — Decide your parameters</h3>

<p>Before touching anything on-chain, pick:</p>

<ul>
  <li><strong>Underlying token address</strong> — whatever holders should redeem for at maturity.</li>
  <li><strong>Payment token address</strong> (may equal the underlying or differ).</li>
  <li><strong>Maturity date</strong> (unix timestamp; must be strictly after <code>endTime</code>).</li>
  <li><strong>Auction window</strong>: <code>startTime</code> and <code>endTime</code> (unix timestamps).</li>
  <li><strong>Pricing</strong>: <code>startingPrice</code> and <code>reservePrice</code> in payment-token smallest-units per whole ZENO. Equal values ⇒ fixed-price bond. <code>reservePrice</code> must be &gt; 0.</li>
  <li><strong><code>totalAllocated</code></strong>: how many ZENO smallest-units the auction can sell (= how much underlying will eventually be owed).</li>
  <li><strong><code>FundingMode</code></strong>: <code>0 = Prefilled</code> or <code>1 = Float</code>.</li>
  <li><strong><code>issuer</code></strong>: the address that receives payment-token from each <code>buy()</code>. Can be an EOA, multisig, or a strategy contract.</li>
  <li><strong><code>initialOwner</code></strong> for both the ZENO and the Auction. Usually your multisig. Owns the ZENO (<code>setAuction</code>, <code>sweepSurplus</code>) and gets <code>DEFAULT_ADMIN_ROLE</code> + <code>PAUSER_ROLE</code> on the Auction.</li>
</ul>

<h3>Step 1 — Deploy the ZENO bond token</h3>

<pre><code>address zeno = zenoFactory.createZENOContract(
    underlyingToken,    // address
    maturityDate,       // uint256 (unix seconds)
    initialOwner        // address — must equal the address that will call setAuction in step 4
);
</code></pre>

<p>Reverts with <code>InvalidMaturityDate</code> if <code>maturityDate &lt;= block.timestamp</code>. The function returns the deployed ZENO address directly. From a wrapper contract, just capture it; from ethers, use <code>staticCall</code> to predict it before sending, or read the <code>ZENOCreated</code> event from the receipt.</p>

<p>The bond is auto-named <code>"ZENO Bond YYYYMMDD"</code> with symbol <code>"ZENO-YYYYMMDD"</code>, where the date is the UTC calendar date of <code>maturityDate</code>.</p>

<h3>Step 2 — Prefill the ZENO contract (Prefilled mode only)</h3>

<p>Skip this step if you're using <code>Float</code>.</p>

<pre><code>IERC20(underlying).transfer(zeno, totalAllocated);
</code></pre>

<p>The transfer can come from anyone holding the underlying — typically the issuer. The <code>Auction</code> constructor in step 3 will revert with <code>NotPrefilled</code> if the ZENO's balance is below <code>totalAllocated</code> at that moment.</p>

<h3>Step 3 — Deploy the Auction</h3>

<pre><code>address auction = auctionFactory.createAuction(
    zeno,               // address from step 1
    paymentToken,       // address
    issuer,             // address — receives payment-token from each buy
    startTime,          // uint256
    endTime,            // uint256 (must be &lt; maturityDate)
    startingPrice,      // uint256
    reservePrice,       // uint256 (&gt; 0)
    totalAllocated,     // uint256
    fundingMode,        // 0 = Prefilled, 1 = Float
    initialOwner        // address
);
</code></pre>

<p>The constructor validates every parameter and (in Prefilled mode) confirms the ZENO is fully backed. The function returns the new auction address directly; the <code>AuctionCreated</code> event also carries it for off-chain indexing.</p>

<h3>Step 4 — Link the auction to the ZENO</h3>

<pre><code>ZENO(zeno).setAuction(auction);   // onlyOwner — must be called by the initialOwner from step 1
</code></pre>

<p>This is one-shot: a subsequent call reverts with <code>AuctionAlreadySet</code>. After this call, the auction can mint and bidders can participate as soon as <code>startTime</code> arrives.</p>

<h3>Why the linking step is separate</h3>

<p>Between steps 3 and 4, the auction is deployed but not yet linked to the ZENO. During this window the owner could otherwise drain the prefill — so <code>ZENO.sweepSurplus</code> reverts with <code>AuctionNotSet</code> until step 4 completes. The cleanest pattern is to bundle all four steps into a single multisig transaction so the window is zero blocks wide.</p>

<h3>Quick checklist (Prefilled bond example)</h3>

<table>
  <tr><th>#</th><th>Action</th><th>Caller</th><th>Reverts if…</th></tr>
  <tr><td>0</td><td>Decide params</td><td>—</td><td>—</td></tr>
  <tr><td>1</td><td><code>zenoFactory.createZENOContract(underlying, maturity, multisig)</code></td><td>Factory owner</td><td>maturity in the past</td></tr>
  <tr><td>2</td><td><code>underlying.transfer(zeno, totalAllocated)</code></td><td>Issuer / treasury</td><td>Insufficient balance</td></tr>
  <tr><td>3</td><td><code>auctionFactory.createAuction(zeno, paymentToken, issuer, …, Prefilled, multisig)</code></td><td>Factory owner</td><td>Prefill short, bad times/prices, maturity ≤ endTime</td></tr>
  <tr><td>4</td><td><code>zeno.setAuction(auction)</code></td><td>ZENO owner (multisig)</td><td>Already set</td></tr>
</table>

<p>For a <strong>Float</strong> bond, skip step 2 — the auction will collect payment-token, and the issuer is responsible for sending underlying into the ZENO contract before <code>maturityDate</code> so redemptions can clear.</p>

<h2>Changes since the original spec</h2>

<p>The original spec described a single-purpose USDC-only bond. The current implementation generalizes that:</p>

<ul>
  <li><strong>Underlying ≠ payment token.</strong> Originally USDC for both; now decoupled with independent decimals.</li>
  <li><strong>Per-auction <code>FundingMode</code></strong> (Prefilled vs Float).</li>
  <li><strong><code>buy(paymentAmount, minZenoOut)</code></strong> — bidder specifies what to spend with slippage protection. Originally <code>buy(zenoAmount)</code>, which forced bidders to pre-compute exact cost.</li>
  <li><strong>Fixed-price bonds</strong> via <code>startingPrice == reservePrice</code>.</li>
  <li><strong><code>reservePrice &gt; 0</code> required.</strong></li>
  <li><strong><code>MATURITY_DATE &gt; auctionEndTime</code> enforced</strong> at auction deploy.</li>
  <li><strong>Emergency surface removed</strong>: <code>emergencyAddress</code>, <code>emergencyRefundERC20</code>, <code>updateEmergencyAddress</code> are all gone.</li>
  <li><strong><code>sweepSurplus</code></strong> replaces <code>emergencyWithdrawUnderlying</code> and is gated on auction-set-and-ended.</li>
  <li><strong><code>totalRemaining</code> derived</strong> from <code>totalAllocated - zeno.totalMinted()</code> rather than stored separately.</li>
  <li><strong>Custom errors throughout</strong> — no string-revert reasons.</li>
  <li><strong>ZENO bond names</strong> are now <code>"ZENO Bond YYYYMMDD"</code> based on maturity date rather than sequential ids.</li>
</ul>

<h2>Running the tests</h2>

<pre><code>npm run test:unit:zeno
</code></pre>

<p>Runs the full Zeno test suite at <code>test/unit/Zeno/Zeno.spec.js</code>. The script prefixes <code>FORK_RPC_URL=</code> to disable the mainnet-fork that's auto-enabled when <code>FORK_RPC_URL</code> is present in <code>.env</code> — the Zeno tests are pure local hardhat-network and do not need fork state.</p>

<p>The suite covers:</p>

<ul>
  <li>Constructor validation (zero addrs, time/price/maturity ordering, prefill boundary)</li>
  <li>Decimals matrix — <code>(D_pay, D_zeno) ∈ {(6,6), (6,18), (18,6), (18,18)}</code></li>
  <li>Rounding invariants (always favor protocol)</li>
  <li>Dutch price curve + fixed-price mode</li>
  <li>Buy flow guards and lifecycle</li>
  <li>Self-buy scenario (issuer == buyer)</li>
  <li>Redemption (pre/post maturity, solvency, top-up)</li>
  <li><code>sweepSurplus</code> gating including the deploy-window case</li>
  <li>Counters (<code>totalMinted</code> monotonic, <code>totalRemaining</code> survives burns)</li>
  <li>Multi-buyer partial-fill accounting</li>
  <li>Factory YYYYMMDD naming</li>
  <li>End-to-end product scenarios (discount bond, decimal-mismatch Dutch auction, self-buy LP seeding)</li>
</ul>
