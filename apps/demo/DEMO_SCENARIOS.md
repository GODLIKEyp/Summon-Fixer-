# Hackathon demo scenarios

All three live edits target **`apps/demo/src/App.tsx` only**. Use the existing
website and overlay; no dashboard or real payment service is involved.
The requested fixes are deliberately **not implemented** in this starting fixture.

For each live edit, select the indicated element with Cmd+Shift+S, submit the
prompt in Manual Approval mode, and inspect the actual proposed source changes.
Confirm the source is unchanged before approval. Suhani must click Approve.
Then check the behavior after HMR, without manually refreshing to demonstrate
the update. This runbook does not establish real-Codex or browser acceptance.

## 1. Functional edit — cart quantity (primary demo)

**Preparation:** The product-page quantity selector already worked. The small
fixture adjustment adds separate, deliberately unconnected cart quantity buttons
using the same styles. Select the **cart drawer's + button**, not the working
product-page selector.

**Starting conditions:** Reload to start with an empty cart and no promo. Leave
the product quantity at one, then click Checkout Now. The drawer shows quantity
1, subtotal $349.00, tax $28.79 and total $377.79. Clicking its + does nothing.

**Prompt:**

> In apps/demo/src/App.tsx only, make this cart item's + and − buttons update its
> quantity, with a minimum of one. Update the cart badge, line price, subtotal,
> tax and total immediately. Preserve other cart items, promo calculations and
> the existing product-page quantity selector.

**Success criteria:** + changes quantity to 2, the badge to 2, line price and
subtotal to $698.00, tax to $57.59 and total to $755.59. − returns to one and
cannot go lower. Adding another finish and changing one row must leave the other
row unchanged; item identity includes both product ID and finish.

## 2. Visual edit — Checkout Now button

**Preparation:** Immediately usable without fixture changes. Close the drawer
and select the product-page Checkout Now button (`checkout-now-button`).

**Prompt:**

> In apps/demo/src/App.tsx only, change this Checkout Now button's label to
> “Buy Now”, keeping the calculated price. Give it a purple #7c3aed background,
> white text and a 16px border radius using an inline style. Preserve its
> checkout click behavior.

**Success criteria:** The new label, color and radius are visible; changing
product quantity still updates the button's price, and clicking opens checkout.

## 3. Bug fix — checkout email validation

**Preparation:** The small fixture adjustment adds a labeled email input.
The existing Place Order handler still ignores email validity. The input is
outside the promo form, and Place Order is a plain button: `type="email"` and
`required` alone do not prevent that handler from running.

**Starting conditions:** Reload, click Checkout Now, enter `not-an-email`, and
click Place Order. The existing simulation incorrectly completes and clears the
cart. Click Continue Browsing, then Checkout Now to restore a cart item. Select
the Place Order button (`place-order-button`) for the fix.

**Prompt:**

> Fix checkout validation in apps/demo/src/App.tsx only. Block empty or malformed
> email addresses before processing starts, preserve the cart on validation
> failure, and show an accessible inline error beside Email. Allow the existing
> demo checkout with a valid email. Preserve the promo form and cart behavior.

**Success criteria:** Both an empty value and `not-an-email` show an inline error
without processing, completion or cart clearing. `demo@example.com` allows the
existing simulated checkout. No payment is charged and no email is sent.

## Rehearsal notes

- Reloading resets in-memory cart, promo and checkout state; it does **not** undo
  approved source edits. These three scenarios can run sequentially in one file.
- Describe the cart controls and email input honestly as starting demo fixtures.
  The checkout completion is a local simulation, not evidence of an AI edit.
- Confirm each proposal stays within App.tsx before approving. Keep Auto Apply
  disabled. Do not claim success until the source change and browser behavior
  have actually been observed.
