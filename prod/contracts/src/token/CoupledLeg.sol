// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RoseToken} from "./RoseToken.sol";
import {ICoupledPair} from "./interface/ICoupledPair.sol";
import {IIdentityRegistry} from "../identity/interface/IIdentityRegistry.sol";

/// @title CoupledLeg — one leg (L or S) of a coupled pair, coupling-gated on emission
/// @notice A Story-4.2 eligibility-gated `RoseToken` whose mint/burn (single-leg emission) is
///         valid ONLY while its `coupler` is mid paired-operation. Combined with owner-as-coupler
///         (the coupler is the sole owner, hence sole caller of the inherited owner-gated
///         `mint`/`burn`), this makes a single-leg mint or burn structurally impossible: the only
///         supply-changing path is `CoupledPair.mintPair`/`burnPair`, which always moves BOTH legs.
/// @dev    Coupling is layered ON TOP of eligibility: `_update` first asserts the coupling rule,
///         then calls `super._update` (RoseToken's eligibility chokepoint → OZ ERC20). Plain
///         transfers carry NO coupling restriction — legs are directionally/separately held (D1)
///         and a transfer cannot change total supply, so it cannot break the coupling invariant
///         (`lToken.totalSupply() == sToken.totalSupply()`). `_update` stays `virtual` so future
///         stories can extend it. Story 4.3 (FR-6, FR-19 coupling).
///
///         Story 4.4 (Model-A bright line, FR-19) layers a THIRD rule on the SAME chokepoint,
///         AFTER `super._update`: each holder has a **segregated principal sub-position**
///         (`_principal[holder]`) — the portion of their collateral that is principal, which a
///         plain fungible token cannot express. The bright line forbids a TRANSFER from dropping a
///         holder's balance below their principal (`balanceOf(from) >= _principal[from]`), so only
///         the YIELD surplus (`balance - principal`) is movable; principal can NEVER leave a
///         position via transfer. Principal decreases ONLY via an authorized paired burn
///         (redemption retires the coupled package incl. principal), clamped so the invariant
///         `_principal[holder] <= balanceOf(holder)` holds in every reachable state. There is
///         deliberately NO owner "release/reclassify principal" path here — reset / P&L
///         crystallization (yield withdrawable vs principal, D1a) is Epics 5-7.
///
///         Story 4.6 (FR-22) closes the 4.4 "single-leg recovery / forced transfer to a new
///         wallet" deferral: a transfer-agent `recoveryAddress` relocates a holder's FULL balance
///         AND its segregated principal to a verified new wallet (`_recoveryInProgress()` ⇒ the
///         principal follows and the bright line is skipped). A PLAIN forced transfer keeps the
///         bright line, so principal still cannot leave a position except via redemption burn or
///         full recovery.
contract CoupledLeg is RoseToken {
    /// @notice The coupling coordinator: the sole owner/minter/burner of this leg.
    address public immutable coupler;

    /// @dev Segregated principal sub-position per holder. Invariant: `_principal[a] <= balanceOf(a)`
    ///      in every reachable state (upheld by `designatePrincipal`, the `_update` bright line, and
    ///      the burn clamp). Yield is the surplus `balanceOf(a) - _principal[a]`.
    mapping(address => uint256) private _principal;

    /// @notice Emitted when `amount` more of `holder`'s balance is carved out as segregated
    ///         principal. `holderPrincipal` is this holder's NEW per-address principal total (NOT a
    ///         protocol-wide aggregate).
    event PrincipalDesignated(address indexed holder, uint256 amount, uint256 holderPrincipal);
    /// @notice Emitted when an authorized burn retires part of `holder`'s principal. `amount` is the
    ///         principal removed; `holderPrincipal` is this holder's NEW per-address principal total
    ///         after the clamp-to-balance (NOT a protocol-wide aggregate).
    event PrincipalReducedOnBurn(address indexed holder, uint256 amount, uint256 holderPrincipal);
    /// @notice Emitted when a transfer-agent recovery (Story 4.6) relocates `amount` of segregated
    ///         principal from `from`'s position to `to`'s new wallet (the principal follows the
    ///         full-balance reissue, preserving the Model-A sub-position across the recovery).
    event PrincipalRecovered(address indexed from, address indexed to, uint256 amount);

    constructor(string memory name_, string memory symbol_, IIdentityRegistry registry_, address coupler_)
        RoseToken(name_, symbol_, registry_, coupler_)
    {
        require(coupler_ != address(0), "CoupledLeg: zero coupler");
        coupler = coupler_;
    }

    /// @notice The segregated principal sub-position of `holder` (the non-movable portion of their
    ///         collateral). Yield = `balanceOf(holder) - principalOf(holder)`.
    function principalOf(address holder) external view returns (uint256) {
        return _principal[holder];
    }

    /// @notice Carve out `amount` MORE of `holder`'s CURRENT balance as segregated principal.
    /// @dev Owner-gated; the owner is the `CoupledPair` coupler, so this is reachable only through
    ///      the pair's forwarders (legs stay sealed from EOAs). Cannot designate more principal than
    ///      the holder actually holds, preserving `_principal[holder] <= balanceOf(holder)`.
    function designatePrincipal(address holder, uint256 amount) external onlyOwner {
        uint256 newPrincipal = _principal[holder] + amount;
        require(newPrincipal <= balanceOf(holder), "CoupledLeg: principal exceeds balance");
        _principal[holder] = newPrincipal;
        emit PrincipalDesignated(holder, amount, newPrincipal);
    }

    /// @dev Three composed rules on ONE chokepoint:
    ///      1. Coupling (4.3, BEFORE `super`): a mint (`from == 0`) or burn (`to == 0`) is a
    ///         single-leg emission, valid ONLY while the coupler is mid paired-op
    ///         (`pairingInProgress()`).
    ///      2. Eligibility (4.2, via `super._update`): recipient/sender must be `isVerified`
    ///         (burn sender-exempt). `super._update` also performs the OZ balance mutation +
    ///         insufficient-balance check.
    ///      3. Model-A bright line (4.4, AFTER `super`): on a TRANSFER (`from != 0 && to != 0`),
    ///         the sender's POST-transfer balance must still cover their segregated principal —
    ///         principal cannot leave a position; only the yield surplus moves. On an authorized
    ///         BURN (`to == 0`), clamp principal down to the remaining balance (redemption retires
    ///         the package incl. principal). Checking AFTER `super` reuses OZ's own
    ///         insufficient-balance revert and avoids an unchecked subtraction underflow.
    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0)) {
            require(ICoupledPair(coupler).pairingInProgress(), "CoupledLeg: single-leg mint/burn");
        }
        super._update(from, to, value);

        if (from != address(0)) {
            if (to == address(0)) {
                // Authorized burn (redemption): clamp principal to remaining balance.
                uint256 bal = balanceOf(from);
                if (_principal[from] > bal) {
                    uint256 reduced = _principal[from] - bal;
                    _principal[from] = bal;
                    emit PrincipalReducedOnBurn(from, reduced, bal);
                }
            } else if (_recoveryInProgress()) {
                // Transfer-agent recovery (4.6): a full-balance reissue to a new wallet. The
                // segregated principal moves WITH the balance (the bright line is intentionally
                // skipped — principal is relocated, not released). Since recovery transfers the
                // ENTIRE `from` balance and `_principal[from] <= old balance == value`, crediting
                // `to` with that principal upholds `_principal[to] <= balanceOf(to)`.
                uint256 p = _principal[from];
                if (p > 0) {
                    _principal[from] = 0;
                    _principal[to] += p;
                    emit PrincipalRecovered(from, to, p);
                }
            } else {
                // Transfer (incl. plain forced transfer): the Model-A bright line — principal
                // cannot leave the position. Only the yield surplus is movable; principal leaves
                // ONLY via an authorized redemption burn or a full recovery to a verified wallet.
                require(balanceOf(from) >= _principal[from], "CoupledLeg: principal cannot leave position");
            }
        }
    }
}
