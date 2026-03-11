/* ===================================
   BODASOKO JAVASCRIPT
   =================================== */

// === STATE MANAGEMENT ===
let currentUserType = null;
let currentCategory = 'all';
let cart = [];
let riderStatus = 'offline';

// === BUSINESSES DATA ===
const businesses = [
    { 
        id: 1, 
        name: 'Mama SYMO Shop', 
        type: 'shop', 
        category: 'groceries', 
        location: 'Chuka Town', 
        distance: 2.3, 
        rating: 4.8, 
        deliveryFee: 50, 
        image: '🛒',
        items: [
            { id: 101, name: 'Maize Flour 2kg', price: 150, image: '🌽' },
            { id: 102, name: 'Sugar 1kg', price: 120, image: '🍬' },
            { id: 103, name: 'Rice 2kg', price: 200, image: '🍚' },
            { id: 104, name: 'Cooking Oil 1L', price: 280, image: '🫗' }
        ]
    },
    { 
        id: 2, 
        name: 'Tasty Bites Restaurant', 
        type: 'restaurant', 
        category: 'food', 
        location: 'Market Area', 
        distance: 1.8, 
        rating: 4.6, 
        deliveryFee: 100, 
        image: '🍽️',
        items: [
            { id: 201, name: 'Chicken & Chips', price: 350, image: '🍗' },
            { id: 202, name: 'Beef Stew & Ugali', price: 250, image: '🍲' },
            { id: 203, name: 'Pilau', price: 200, image: '🍛' },
            { id: 204, name: 'Fish & Ugali', price: 300, image: '🐟' }
        ]
    },
    { 
        id: 3, 
        name: 'Fresh Greens Market', 
        type: 'groceries', 
        category: 'groceries', 
        location: 'Bus Stage', 
        distance: 3.1, 
        rating: 4.9, 
        deliveryFee: 70, 
        image: '🥬',
        items: [
            { id: 301, name: 'Tomatoes 1kg', price: 80, image: '🍅' },
            { id: 302, name: 'Onions 1kg', price: 70, image: '🧅' },
            { id: 303, name: 'Sukuma Wiki', price: 30, image: '🥬' },
            { id: 304, name: 'Potatoes 2kg', price: 100, image: '🥔' }
        ]
    },
    { 
        id: 4, 
        name: 'Quick Bites Cafe', 
        type: 'restaurant', 
        category: 'food', 
        location: 'Hospital Road', 
        distance: 2.7, 
        rating: 4.5, 
        deliveryFee: 80, 
        image: '☕',
        items: [
            { id: 401, name: 'Mandazi (6 pcs)', price: 60, image: '🥐' },
            { id: 402, name: 'Tea/Coffee', price: 40, image: '☕' },
            { id: 403, name: 'Samosa (3 pcs)', price: 90, image: '🥟' },
            { id: 404, name: 'Chapati & Beans', price: 100, image: '🫓' }
        ]
    },
    { 
        id: 5, 
        name: 'Purity Pharmacy', 
        type: 'pharmacy', 
        category: 'health', 
        location: 'County Road', 
        distance: 2.0, 
        rating: 4.9, 
        deliveryFee: 50, 
        image: '💊',
        items: [
            { id: 601, name: 'Paracetamol', price: 50, image: '💊' },
            { id: 602, name: 'First Aid Kit', price: 350, image: '🩹' },
            { id: 603, name: 'Hand Sanitizer', price: 150, image: '🧴' },
            { id: 604, name: 'Face Masks (10)', price: 100, image: '😷' }
        ]
    }
];

// === USER TYPE SELECTION ===
function selectUserType(type) {
    currentUserType = type;
    
    // Hide user selection
    document.getElementById('user-selection').classList.add('hidden');
    
    // Show navigation
    document.getElementById('navbar').classList.remove('hidden');
    
    // Show appropriate page
    if (type === 'customer') {
        showPage('browse');
        document.getElementById('cart-btn').classList.remove('hidden');
        document.getElementById('nav-links').classList.remove('hidden');
        renderBusinesses();
    } else if (type === 'rider') {
        showPage('rider');
        document.getElementById('cart-btn').classList.add('hidden');
        document.getElementById('nav-links').classList.add('hidden');
        renderRiderOrders();
    } else if (type === 'business') {
        showPage('business');
        document.getElementById('cart-btn').classList.add('hidden');
        document.getElementById('nav-links').classList.add('hidden');
        renderBusinessOrders();
    }
}

function switchUser() {
    currentUserType = null;
    cart = [];
    
    // Hide all pages
    document.querySelectorAll('.page').forEach(page => page.classList.add('hidden'));
    document.getElementById('navbar').classList.add('hidden');
    
    // Show user selection
    document.getElementById('user-selection').classList.remove('hidden');
}

// === PAGE NAVIGATION ===
function showPage(pageName) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(page => page.classList.add('hidden'));
    
    // Show selected page
    const page = document.getElementById(pageName + '-page');
    if (page) {
        page.classList.remove('hidden');
    }
}

// === BUSINESS RENDERING ===
function renderBusinesses() {
    const container = document.getElementById('businesses-grid');
    if (!container) return;
    
    const filtered = currentCategory === 'all' 
        ? businesses 
        : businesses.filter(b => b.category === currentCategory);
    
    container.innerHTML = filtered.map(business => createBusinessCard(business)).join('');
}

function createBusinessCard(business) {
    const itemsHTML = business.items.slice(0, 3).map(item => `
        <div class="item-row">
            <div class="item-info">
                <span class="item-icon">${item.image}</span>
                <div>
                    <div class="item-name">${item.name}</div>
                    <div class="item-price">KES ${item.price}</div>
                </div>
            </div>
            <button class="add-btn" onclick="addToCart(${business.id}, ${item.id})">
                Add
            </button>
        </div>
    `).join('');
    
    return `
        <div class="business-card">
            <div class="business-image">${business.image}</div>
            <div class="business-info">
                <h3 class="business-name">${business.name}</h3>
                <div class="business-meta">
                    <div class="meta-item">
                        📍 ${business.distance}km away
                    </div>
                    <div class="meta-item">
                        ⭐ ${business.rating}
                    </div>
                </div>
                <div class="delivery-badge">
                    🏍️ Delivery: KES ${business.deliveryFee} • 20-30 mins
                </div>
                <div class="items-list">
                    ${itemsHTML}
                </div>
                <button class="view-all-btn">
                    View All Items →
                </button>
            </div>
        </div>
    `;
}

// === CATEGORY FILTERING ===
function selectCategory(category) {
    currentCategory = category;
    
    // Update active pill
    document.querySelectorAll('.pill').forEach(pill => {
        pill.classList.remove('active');
    });
    event.target.classList.add('active');
    
    renderBusinesses();
}

function filterBusinesses() {
    const searchTerm = document.getElementById('search-input').value.toLowerCase();
    const container = document.getElementById('businesses-grid');
    
    let filtered = currentCategory === 'all' 
        ? businesses 
        : businesses.filter(b => b.category === currentCategory);
    
    if (searchTerm) {
        filtered = filtered.filter(b => 
            b.name.toLowerCase().includes(searchTerm) ||
            b.items.some(item => item.name.toLowerCase().includes(searchTerm))
        );
    }
    
    container.innerHTML = filtered.map(business => createBusinessCard(business)).join('');
}

// === CART MANAGEMENT ===
function addToCart(businessId, itemId) {
    const business = businesses.find(b => b.id === businessId);
    const item = business.items.find(i => i.id === itemId);
    
    const existingItem = cart.find(c => c.businessId === businessId && c.itemId === itemId);
    
    if (existingItem) {
        existingItem.quantity += 1;
    } else {
        cart.push({
            businessId: business.id,
            businessName: business.name,
            itemId: item.id,
            name: item.name,
            price: item.price,
            image: item.image,
            quantity: 1,
            deliveryFee: business.deliveryFee
        });
    }
    
    updateCart();
    toggleCart(true);
}

function removeFromCart(businessId, itemId) {
    cart = cart.filter(item => !(item.businessId === businessId && item.itemId === itemId));
    updateCart();
}

function updateQuantity(businessId, itemId, newQty) {
    if (newQty === 0) {
        removeFromCart(businessId, itemId);
        return;
    }
    
    const item = cart.find(c => c.businessId === businessId && c.itemId === itemId);
    if (item) {
        item.quantity = newQty;
        updateCart();
    }
}

function updateCart() {
    const cartBadge = document.getElementById('cart-badge');
    const cartItems = document.getElementById('cart-items');
    const cartEmpty = document.getElementById('cart-empty');
    const cartFooter = document.getElementById('cart-footer');
    
    // Update badge
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    cartBadge.textContent = totalItems;
    
    // Update cart display
    if (cart.length === 0) {
        cartEmpty.style.display = 'block';
        cartFooter.classList.add('hidden');
        cartItems.innerHTML = '<div class="cart-empty"><div class="empty-icon">🛒</div><p>Your cart is empty</p></div>';
    } else {
        cartEmpty.style.display = 'none';
        cartFooter.classList.remove('hidden');
        
        cartItems.innerHTML = cart.map((item, index) => `
            <div class="cart-item">
                <div class="cart-item-top">
                    <div class="cart-item-info">
                        <span class="cart-item-icon">${item.image}</span>
                        <div>
                            <div class="cart-item-name">${item.name}</div>
                            <div class="cart-item-business">${item.businessName}</div>
                            <div class="cart-item-price">KES ${item.price}</div>
                        </div>
                    </div>
                    <button class="remove-btn" onclick="removeFromCart(${item.businessId}, ${item.itemId})">
                        ✕
                    </button>
                </div>
                <div class="cart-item-bottom">
                    <div class="quantity-controls">
                        <button class="qty-btn" onclick="updateQuantity(${item.businessId}, ${item.itemId}, ${item.quantity - 1})">-</button>
                        <span class="qty-display">${item.quantity}</span>
                        <button class="qty-btn" onclick="updateQuantity(${item.businessId}, ${item.itemId}, ${item.quantity + 1})">+</button>
                    </div>
                    <div class="item-total">KES ${item.price * item.quantity}</div>
                </div>
            </div>
        `).join('');
        
        // Update totals
        const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const deliveryFees = [...new Set(cart.map(item => item.deliveryFee))].reduce((sum, fee) => sum + fee, 0);
        const grandTotal = subtotal + deliveryFees;
        
        document.getElementById('subtotal').textContent = `KES ${subtotal}`;
        document.getElementById('delivery-fee').textContent = `KES ${deliveryFees}`;
        document.getElementById('grand-total').textContent = `KES ${grandTotal}`;
    }
}

function toggleCart(forceOpen = false) {
    const sidebar = document.getElementById('cart-sidebar');
    const overlay = document.getElementById('cart-overlay');
    
    if (forceOpen) {
        sidebar.classList.add('active');
        overlay.classList.add('active');
    } else {
        sidebar.classList.toggle('active');
        overlay.classList.toggle('active');
    }
}

function placeOrder() {
    if (cart.length === 0) return;
    
    alert('🎉 Order placed successfully!\n\nA rider will be assigned shortly.\nExpected delivery: 20-40 minutes\n\n💳 Pay on delivery');
    
    cart = [];
    updateCart();
    toggleCart();
}

// === RIDER DASHBOARD ===
function toggleRiderStatus() {
    const statusBtn = document.getElementById('status-btn');
    const statusText = document.getElementById('status-text');
    
    if (riderStatus === 'offline') {
        riderStatus = 'online';
        statusBtn.textContent = '✓ Online';
        statusBtn.classList.add('online');
        statusText.textContent = 'Status: Available for deliveries';
        renderRiderOrders();
    } else {
        riderStatus = 'offline';
        statusBtn.textContent = 'Go Online';
        statusBtn.classList.remove('online');
        statusText.textContent = 'Status: Offline';
        renderRiderOrders();
    }
}

function renderRiderOrders() {
    const container = document.getElementById('available-orders');
    if (!container) return;
    
    if (riderStatus === 'offline') {
        container.innerHTML = `
            <div class="offline-state">
                <div class="offline-icon">🏍️</div>
                <p>Go online to see available orders</p>
            </div>
        `;
    } else {
        container.innerHTML = [1, 2, 3].map(i => `
            <div class="order-card">
                <div class="order-header">
                    <div>
                        <div class="order-id">Order #${1000 + i}</div>
                        <div class="order-from">From Mama Njeri Shop</div>
                    </div>
                    <div class="order-fee">
                        <div class="fee-amount">KES 150</div>
                        <div class="fee-label">Delivery fee</div>
                    </div>
                </div>
                <div class="order-meta">
                    📍 2.3 km away • 15 min ride
                </div>
                <div class="order-actions">
                    <button class="accept-btn" onclick="acceptOrder(${1000 + i})">
                        Accept Order
                    </button>
                    <button class="details-btn">
                        Details
                    </button>
                </div>
            </div>
        `).join('');
    }
}

function acceptOrder(orderId) {
    alert(`✓ Order #${orderId} accepted!\n\nPick up from: Mama Njeri Shop\nDeliver to: Customer location\n\nStart navigation?`);
}

// === BUSINESS DASHBOARD ===
function renderBusinessOrders() {
    const container = document.getElementById('business-orders');
    if (!container) return;
    
    container.innerHTML = [1, 2, 3, 4].map(i => `
        <div class="order-card">
            <div class="order-header">
                <div>
                    <div class="order-id">Order #${5000 + i}</div>
                    <div class="order-from">3 items • KES 620</div>
                    <div class="fee-label">5 minutes ago</div>
                </div>
                <div class="order-actions">
                    <button class="accept-btn" onclick="acceptBusinessOrder(${5000 + i})">
                        Accept
                    </button>
                    <button class="details-btn">
                        Details
                    </button>
                </div>
            </div>
        </div>
    `).join('');
}

function acceptBusinessOrder(orderId) {
    alert(`✓ Order #${orderId} accepted!\n\nPrepare the items.\nRider will arrive in 10 minutes.`);
}

// === INITIALIZATION ===
document.addEventListener('DOMContentLoaded', function() {
    console.log('BodaSoko initialized! 🏍️');
});