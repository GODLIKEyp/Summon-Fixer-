import React, { useState } from 'react';

interface CartItem {
  id: string;
  name: string;
  color: string;
  price: number;
  quantity: number;
}

const COLOR_OPTIONS = [
  { id: 'obsidian', name: 'Matte Obsidian', hex: '#1c1d22', accent: '#383a42' },
  { id: 'silver', name: 'Nordic Silver', hex: '#e2e5ea', accent: '#cbd0d8' },
  { id: 'navy', name: 'Midnight Navy', hex: '#16243b', accent: '#263d63' },
];

export function App() {
  const [selectedColor, setSelectedColor] = useState(COLOR_OPTIONS[0]);
  const [quantity, setQuantity] = useState(1);
  const [isWishlisted, setIsWishlisted] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState(false);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [orderComplete, setOrderComplete] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const basePrice = 349;
  const originalPrice = 399;

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const handleAddToCart = () => {
    setCart((prev) => {
      const existing = prev.find(
        (item) => item.id === 'aura-master-one' && item.color === selectedColor.name
      );
      if (existing) {
        return prev.map((item) =>
          item.id === 'aura-master-one' && item.color === selectedColor.name
            ? { ...item, quantity: item.quantity + quantity }
            : item
        );
      }
      return [
        ...prev,
        {
          id: 'aura-master-one',
          name: 'Aura Studio Pro Wireless',
          color: selectedColor.name,
          price: basePrice,
          quantity,
        },
      ];
    });
    showToast(`Added ${quantity} × ${selectedColor.name} to cart`);
  };

  const handleQuickCheckout = () => {
    if (cart.length === 0) {
      handleAddToCart();
    }
    setIsCheckoutOpen(true);
  };

  const totalCartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartSubtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const discount = promoApplied ? cartSubtotal * 0.1 : 0;
  const estimatedTax = (cartSubtotal - discount) * 0.0825;
  const finalTotal = cartSubtotal - discount + estimatedTax;

  const handleApplyPromo = (e: React.FormEvent) => {
    e.preventDefault();
    if (promoCode.trim().toUpperCase() === 'SUMMON10') {
      setPromoApplied(true);
      showToast('10% discount applied!');
    } else {
      showToast('Invalid promo code. Try SUMMON10');
    }
  };

  const handlePlaceOrder = () => {
    setIsPlacingOrder(true);
    setTimeout(() => {
      setIsPlacingOrder(false);
      setOrderComplete(true);
      setCart([]);
    }, 1200);
  };

  return (
    <div className="aura-app">
      {/* Announcement bar */}
      <div className="announcement-bar" role="banner">
        <span>Complimentary Express Shipping on Orders over $200 • 30-Day Studio Audition</span>
      </div>

      {/* Main Navigation */}
      <header className="navbar" role="navigation" aria-label="Main navigation">
        <div className="navbar-container">
          <div className="brand" id="brand-logo">
            <span className="brand-icon">▲</span>
            <div className="brand-text">
              <span className="brand-title">AURA</span>
              <span className="brand-subtitle">STUDIO ACOUSTICS</span>
            </div>
          </div>

          <nav className="nav-links">
            <a href="#headphones" className="nav-link active">Headphones</a>
            <a href="#earphones" className="nav-link">Earphones</a>
            <a href="#accessories" className="nav-link">Accessories</a>
            <a href="#stories" className="nav-link">Stories</a>
          </nav>

          <div className="nav-actions">
            <button
              type="button"
              className="action-btn"
              aria-label="Toggle wishlist"
              id="wishlist-toggle"
              onClick={() => {
                setIsWishlisted(!isWishlisted);
                showToast(isWishlisted ? 'Removed from wishlist' : 'Saved to wishlist');
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill={isWishlisted ? '#f43f5e' : 'none'} stroke={isWishlisted ? '#f43f5e' : 'currentColor'} strokeWidth="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
            </button>

            <button
              type="button"
              className="action-btn cart-btn"
              aria-label="View shopping cart"
              id="open-cart-btn"
              onClick={() => setIsCheckoutOpen(true)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <path d="M16 10a4 4 0 0 1-8 0" />
              </svg>
              {totalCartCount > 0 && (
                <span className="cart-badge" id="cart-counter">{totalCartCount}</span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Product Showcase */}
      <main className="main-content">
        <div className="product-showcase">
          {/* Visual Showcase */}
          <div className="product-visual-col">
            <div className="product-badge-row">
              <span className="badge-pill">NEW RELEASE</span>
              <span className="badge-sub">STUDIO REFERENCE MARK II</span>
            </div>

            <div className="product-card-preview" style={{ background: `radial-gradient(circle at center, ${selectedColor.accent}33 0%, rgba(15, 17, 23, 0.95) 75%)` }}>
              <div className="headphone-art">
                <div className="headband" style={{ borderColor: selectedColor.hex }} />
                <div className="earcup left" style={{ backgroundColor: selectedColor.hex }} />
                <div className="earcup right" style={{ backgroundColor: selectedColor.hex }} />
                <div className="soundwave-pulse" />
              </div>

              <div className="spec-tags">
                <span className="spec-tag">45mm Planar Drivers</span>
                <span className="spec-tag">Hybrid ANC</span>
                <span className="spec-tag">42h Playtime</span>
                <span className="spec-tag">Lossless LDAC</span>
              </div>
            </div>
          </div>

          {/* Product Details & Purchase Form */}
          <div className="product-details-col">
            <div className="product-header">
              <span className="product-category">Studio Wireless Headphones</span>
              <h1 className="product-title" id="product-heading">Aura Studio Pro Wireless</h1>

              <div className="rating-row">
                <div className="stars" aria-label="Rating: 4.9 out of 5 stars">
                  ★★★★★
                </div>
                <span className="rating-score">4.9</span>
                <span className="rating-count">(128 studio reviews)</span>
              </div>
            </div>

            <div className="price-row" id="product-price-box">
              <span className="current-price">${basePrice}.00</span>
              <span className="original-price">${originalPrice}.00</span>
              <span className="save-badge">Save $50</span>
            </div>

            <p className="product-description" id="product-description-text">
              Engineered with custom 45mm planar magnetic transducers and dual-core digital
              signal processing. Delivers reference-grade acoustic neutrality, adaptive noise
              cancellation, and 42 hours of uncompromising wireless playback.
            </p>

            {/* Color Selector */}
            <div className="selector-group">
              <label className="selector-label">
                Color Finish: <span className="selected-value">{selectedColor.name}</span>
              </label>
              <div className="color-swatches" role="radiogroup" aria-label="Headphone color options">
                {COLOR_OPTIONS.map((color) => (
                  <button
                    key={color.id}
                    type="button"
                    className={`color-swatch-btn ${selectedColor.id === color.id ? 'active' : ''}`}
                    onClick={() => setSelectedColor(color)}
                    aria-label={`Select ${color.name}`}
                    style={{ backgroundColor: color.hex }}
                  />
                ))}
              </div>
            </div>

            {/* Quantity Selector */}
            <div className="selector-group">
              <label className="selector-label">Quantity</label>
              <div className="quantity-stepper">
                <button
                  type="button"
                  className="step-btn"
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  aria-label="Decrease quantity"
                  disabled={quantity <= 1}
                >
                  −
                </button>
                <span className="quantity-value" id="current-quantity">{quantity}</span>
                <button
                  type="button"
                  className="step-btn"
                  onClick={() => setQuantity((q) => q + 1)}
                  aria-label="Increase quantity"
                >
                  +
                </button>
              </div>
            </div>

            {/* CTAs */}
            <div className="cta-action-row">
              <button
                type="button"
                className="btn btn-secondary"
                id="add-to-cart-button"
                onClick={handleAddToCart}
              >
                Add to Cart
              </button>
              <button
                type="button"
                className="btn btn-primary"
                id="checkout-now-button"
                onClick={handleQuickCheckout}
              >
                Checkout Now • ${(basePrice * quantity).toFixed(2)}
              </button>
            </div>

            {/* Value Guarantees */}
            <div className="guarantees-grid">
              <div className="guarantee-item">
                <span className="guarantee-icon">⚡</span>
                <div className="guarantee-text">
                  <strong>Free Express Courier</strong>
                  <span>Delivered within 2–3 business days</span>
                </div>
              </div>
              <div className="guarantee-item">
                <span className="guarantee-icon">🛡️</span>
                <div className="guarantee-text">
                  <strong>2-Year Studio Warranty</strong>
                  <span>Comprehensive parts & driver coverage</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Feature Highlights Section */}
        <section className="features-section">
          <h2 className="section-title">Acoustic Mastery in Every Detail</h2>
          <div className="features-grid">
            <div className="feature-card">
              <div className="feature-icon">🔊</div>
              <h3 className="feature-title">Planar Magnetic Transducers</h3>
              <p className="feature-body">
                Ultra-thin 1.5-micron diaphragm suspended between neodymium magnets delivers
                sub-0.05% THD across the 10Hz–45kHz spectrum.
              </p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🔇</div>
              <h3 className="feature-title">Adaptive Acoustic ANC</h3>
              <p className="feature-body">
                Eight calibrated microphones sample ambient sound at 48,000 times per second,
                filtering out unwanted frequency spikes dynamically.
              </p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🔋</div>
              <h3 className="feature-title">42-Hour Uninterrupted Power</h3>
              <p className="feature-body">
                Rapid USB-C charging restores 6 hours of high-resolution playtime in just
                15 minutes of charging.
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* Interactive Checkout Drawer */}
      {isCheckoutOpen && (
        <div className="modal-backdrop" onClick={() => setIsCheckoutOpen(false)}>
          <div
            className="checkout-drawer"
            role="dialog"
            aria-label="Checkout drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-header">
              <h2 className="drawer-title">Review & Checkout</h2>
              <button
                type="button"
                className="close-btn"
                aria-label="Close checkout"
                onClick={() => setIsCheckoutOpen(false)}
              >
                ✕
              </button>
            </div>

            {orderComplete ? (
              <div className="order-success-view">
                <div className="success-icon">✓</div>
                <h3>Order Confirmed!</h3>
                <p>Order <strong>#SF-8924</strong> has been placed.</p>
                <p className="sub-text">A confirmation email has been dispatched to your inbox.</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setOrderComplete(false);
                    setIsCheckoutOpen(false);
                  }}
                >
                  Continue Browsing
                </button>
              </div>
            ) : (
              <div className="drawer-body">
                {cart.length === 0 ? (
                  <div className="empty-cart-state">
                    <p>Your shopping bag is currently empty.</p>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setIsCheckoutOpen(false)}
                    >
                      Return to Store
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="cart-items-list">
                      {cart.map((item, index) => (
                        <div key={`${item.id}-${item.color}-${index}`} className="cart-item-row">
                          <div className="item-details">
                            <h4 className="item-title">{item.name}</h4>
                            <span className="item-variant">Finish: {item.color}</span>
                            <span className="item-qty">Qty: {item.quantity}</span>
                          </div>
                          <div className="item-price">
                            ${(item.price * item.quantity).toFixed(2)}
                          </div>
                        </div>
                      ))}
                    </div>

                    <form className="promo-form" onSubmit={handleApplyPromo}>
                      <input
                        type="text"
                        className="promo-input"
                        placeholder="Discount code (try SUMMON10)"
                        value={promoCode}
                        onChange={(e) => setPromoCode(e.target.value)}
                      />
                      <button type="submit" className="btn btn-small">Apply</button>
                    </form>

                    <div className="order-breakdown">
                      <div className="breakdown-row">
                        <span>Subtotal</span>
                        <span>${cartSubtotal.toFixed(2)}</span>
                      </div>
                      {promoApplied && (
                        <div className="breakdown-row discount">
                          <span>Promo Discount (10%)</span>
                          <span>-${discount.toFixed(2)}</span>
                        </div>
                      )}
                      <div className="breakdown-row">
                        <span>Express Shipping</span>
                        <span className="free-tag">Free</span>
                      </div>
                      <div className="breakdown-row">
                        <span>Estimated Tax</span>
                        <span>${estimatedTax.toFixed(2)}</span>
                      </div>
                      <div className="breakdown-row total">
                        <strong>Total</strong>
                        <strong>${finalTotal.toFixed(2)}</strong>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn btn-primary place-order-btn"
                      id="place-order-button"
                      disabled={isPlacingOrder}
                      onClick={handlePlaceOrder}
                    >
                      {isPlacingOrder ? 'Processing...' : `Place Order • $${finalTotal.toFixed(2)}`}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="aura-toast" role="status">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
export default App;
