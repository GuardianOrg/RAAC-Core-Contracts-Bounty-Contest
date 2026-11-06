## What is RAAC?

RAAC (Regnum Aurum Acquisition Corp) is a DeFi protocol bridging **real-world real-estate** and on-chain finance.  
It offers two complementary forms of real-estate exposure:

* **Whole-asset exposure** through 🔑 **RAACNFT** – an ERC-721 that represents a single tokenised property.
* **Fractional exposure** through 🏛 **iRAAC** – an ERC-20 index token minted by the **RWA Vault** which holds a diversified basket of RAACNFTs and stablecoins.

Both tokens can be supplied as **collateral** inside RAAC's LendingPool, enabling trust-minimised borrowing against real-estate value.

---

## Core Building Blocks

| Component | Purpose |
|-----------|---------|
| **RAACNFT** | Non-fungible token representing individual properties. Mint price = on-chain appraisal from `RAACHousePriceOracle`. |
| **RWA Vault** | Hybrid vault that accepts ERC-20 & ERC-721 assets. Depositors receive iRAAC shares; anyone can burn iRAAC to randomly **redeem an underlying NFT**. |
| **iRAAC** | ERC-20 index token backed 1-for-1 by the vault NAV (NFTs + stablecoins). Fully composable across DeFi and accepted as collateral in the LendingPool. |
| **LendingPool** | Money-market supporting multi-asset collateral (RAACNFT, iRAAC, crvUSD…). Issues `DebtToken` to borrowers and `RToken` to suppliers. |
| **Stability Pool** | Back-stops bad debt. Users deposit RToken → receive DEToken + RAAC rewards and can participate in liquidations. |
| **RAAC Token** | Protocol governance & rewards token. Can be locked for up to 4 years to mint **veRAAC** voting power. |

---

## How It All Fits Together

### 1. Tokenising Real Estate

1. A property appraisal is pushed on-chain by Chainlink Functions.  
2. Anyone may **mint a RAACNFT** by paying the current crvUSD valuation (plus mint fee + KYC).
3. The freshly minted NFT can be:
   * kept by the owner,
   * deposited as **collateral** in the LendingPool, **or**
   * fractionalised by depositing it into the RWA Vault in exchange for iRAAC.

### 2. Fractional Exposure & NFT Redemption

* **Deposit path** – Supply crvUSD, RAACNFT or other whitelisted assets to the RWA Vault → receive **iRAAC**.
* **Redemption path** – Burn iRAAC to randomly draw and redeem a RAACNFT (selection powered by Chainlink VRF to guarantee fairness).

### 3. Lending & Borrowing

* **Supply side** – Deposit crvUSD into the LendingPool to mint **RToken** (interest-bearing receipt).
* **Borrow side** – Open a loan against your supplied collateral and receive crvUSD. Interest rate = US Prime base / 2 (oracle-fed) ± utilisation spread.
* **Liquidations** – Under-collateralised positions are stabilised via the Stability Pool which can convert seized collateral into iRAAC and ultimately crvUSD.

### 4. Stability Pool & RAAC Rewards

1. Users deposit RToken → receive **DEToken** (1:1). The DEToken can be staked up in gauges to receive rental yield and rewards.
2. During liquidations the pool swaps seized collateral for crvUSD, realising a spread that boosts depositor yields.

### 5. Governance & Gauges

* Lock RAAC to mint **veRAAC** and gain voting power.  
* Dual-gauge system (weekly & monthly) directs future RAAC inflation toward selected pools or strategies, purely by veRAAC vote.

---

## Example User Journeys

### A. Fractional Investor → veRAAC Holder

1. Swap crvUSD for **iRAAC** on a DEX *or* mint iRAAC directly via the RWA Vault.  
2. Deposit iRAAC into the LendingPool as collateral and borrow crvUSD.  
3. Route the borrowed crvUSD into the Stability Pool → farm **Rewards**.  
4. Lock RAAC for up to 4 years to obtain **veRAAC** voting power.

### B. Property Owner Looking for Liquidity

1. Mint **RAACNFT** representing the property.  
2. Deposit the NFT into the LendingPool.  
3. Borrow up to the allowed LTV in crvUSD.  
4. If desired, fractionalise the NFT later by redeeming it via the RWA Vault.

### C. NFT-Flipper Hunting Deals

1. Accumulate **iRAAC** on the open market.  
2. Call `redeemNFT()` on the RWA Vault to burn shares and receive a randomly selected RAACNFT.  
3. Sell the NFT on a marketplace or deposit it back into the vault for fresh iRAAC.

---

## Key Takeaways

* **iRAAC & RAACNFT are now first-class collateral types** across the RAAC ecosystem.
* The **RWA Vault** unlocks seamless switching between fractional and whole-asset exposure.
* Chainlink Functions & VRF ensure on-chain valuations and fair NFT distribution.
* Depositors, borrowers and liquidators are all rewarded in **RAAC**, with veRAAC steering future emission flows.
