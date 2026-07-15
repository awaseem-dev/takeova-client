/**
 * MINE v31 - Comprehensive API Integration
 * 
 * This file contains all API integration functions to make dashboard buttons functional.
 * Include this file in your dashboards to enable full backend connectivity.
 * 
 * Usage: <script src="mine-api-integration.js"></script>
 */

// ══════════════════════════════════════════════════════════════════════════════
// SITES MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

window.createSite = async function() {
  const name = prompt('Site name:');
  if (!name) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    const response = await fetch(api + '/api/sites', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, template: 'default' })
    });
    const data = await response.json();
    if (typeof toast === 'function') toast('Site created ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
    return data;
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
    throw e;
  }
};

window.deleteSite = async function(siteId) {
  if (!confirm('Delete this site?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/sites/' + siteId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Site deleted');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.publishSite = async function(siteId) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/sites/' + siteId + '/publish', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Site published ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.duplicateSite = async function(siteId) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    const response = await fetch(api + '/api/sites/' + siteId + '/duplicate', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await response.json();
    if (typeof toast === 'function') toast('Site duplicated ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
    return data;
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCTS MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

window.createProduct = async function() {
  const name = prompt('Product name:');
  if (!name) return;
  const price = prompt('Price (e.g. 29.99):');
  if (!price) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/products', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        name, 
        price: parseFloat(price), 
        currency: 'USD',
        status: 'active'
      })
    });
    if (typeof toast === 'function') toast('Product created ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.updateProduct = async function(productId, updates) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/products/' + productId, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    });
    if (typeof toast === 'function') toast('Product updated ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.deleteProduct = async function(productId) {
  if (!confirm('Delete this product?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/products/' + productId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Product deleted');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// ORDERS MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

window.updateOrderStatus = async function(orderId, status) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/orders/' + orderId, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status })
    });
    if (typeof toast === 'function') toast('Order updated ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.refundOrder = async function(orderId) {
  if (!confirm('Issue refund for this order?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/orders/' + orderId + '/refund', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Refund processed ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.exportOrders = async function(format) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    const response = await fetch(api + '/api/orders/export?format=' + (format || 'csv'), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'orders_' + new Date().toISOString().split('T')[0] + '.' + (format || 'csv');
    a.click();
    if (typeof toast === 'function') toast('Export downloaded ✓');
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// CUSTOMERS/CONTACTS
// ══════════════════════════════════════════════════════════════════════════════

window.createContact = async function() {
  const name = prompt('Contact name:');
  if (!name) return;
  const email = prompt('Email:');
  if (!email) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/contacts', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, email })
    });
    if (typeof toast === 'function') toast('Contact added ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.deleteContact = async function(contactId) {
  if (!confirm('Delete this contact?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/contacts/' + contactId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Contact deleted');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.importContacts = async function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const api = window._api ? window._api() : window.MINE_API;
      const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
      const response = await fetch(api + '/api/contacts/import', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: formData
      });
      const data = await response.json();
      if (typeof toast === 'function') toast('Imported ' + (data.count || 0) + ' contacts ✓');
      if (typeof refreshPanel === 'function') refreshPanel();
    } catch(e) {
      if (typeof toast === 'function') toast('Import failed: ' + e.message);
    }
  };
  input.click();
};

window.exportContacts = async function() {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    const response = await fetch(api + '/api/contacts/export', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contacts_' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    if (typeof toast === 'function') toast('Export downloaded ✓');
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// EMAIL CAMPAIGNS
// ══════════════════════════════════════════════════════════════════════════════

window.createCampaign = async function() {
  const subject = prompt('Email subject:');
  if (!subject) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/email/campaigns', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ subject, status: 'draft' })
    });
    if (typeof toast === 'function') toast('Campaign created ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.sendCampaign = async function(campaignId) {
  if (!confirm('Send this campaign now?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/email/campaigns/' + campaignId + '/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Campaign sent ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.sendTestEmail = async function(campaignId) {
  const email = prompt('Send test to email:');
  if (!email) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/email/campaigns/' + campaignId + '/test', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });
    if (typeof toast === 'function') toast('Test email sent ✓');
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.deleteCampaign = async function(campaignId) {
  if (!confirm('Delete this campaign?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/email/campaigns/' + campaignId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Campaign deleted');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// BOOKINGS
// ══════════════════════════════════════════════════════════════════════════════

window.createBooking = async function() {
  const customerEmail = prompt('Customer email:');
  if (!customerEmail) return;
  const date = prompt('Date (YYYY-MM-DD):');
  if (!date) return;
  const time = prompt('Time (HH:MM):') || '10:00';
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/bookings', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ customerEmail, date, time, service: 'Consultation' })
    });
    if (typeof toast === 'function') toast('Booking created ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.cancelBooking = async function(bookingId) {
  if (!confirm('Cancel this booking?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/bookings/' + bookingId + '/cancel', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Booking cancelled');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.confirmBooking = async function(bookingId) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/bookings/' + bookingId + '/confirm', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Booking confirmed ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// FORMS
// ══════════════════════════════════════════════════════════════════════════════

window.createForm = async function() {
  const name = prompt('Form name:');
  if (!name) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/forms', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, fields: [] })
    });
    if (typeof toast === 'function') toast('Form created ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.deleteForm = async function(formId) {
  if (!confirm('Delete this form?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/forms/' + formId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Form deleted');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.exportFormSubmissions = async function(formId) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    const response = await fetch(api + '/api/forms/' + formId + '/submissions/export', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'form_submissions_' + formId + '.csv';
    a.click();
    if (typeof toast === 'function') toast('Export downloaded ✓');
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// COURSES
// ══════════════════════════════════════════════════════════════════════════════

window.createCourse = async function() {
  const title = prompt('Course title:');
  if (!title) return;
  const price = prompt('Price:');
  if (!price) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/courses', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title, price: parseFloat(price), status: 'draft' })
    });
    if (typeof toast === 'function') toast('Course created ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.publishCourse = async function(courseId) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/courses/' + courseId + '/publish', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Course published ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.deleteCourse = async function(courseId) {
  if (!confirm('Delete this course?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/courses/' + courseId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Course deleted');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// MEMBERSHIPS
// ══════════════════════════════════════════════════════════════════════════════

window.createMembership = async function() {
  const name = prompt('Membership name:');
  if (!name) return;
  const price = prompt('Monthly price:');
  if (!price) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/memberships', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, price: parseFloat(price), interval: 'month' })
    });
    if (typeof toast === 'function') toast('Membership created ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.deleteMembership = async function(membershipId) {
  if (!confirm('Delete this membership?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/memberships/' + membershipId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Membership deleted');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// AI EMPLOYEES
// ══════════════════════════════════════════════════════════════════════════════

window.hireAIEmployee = async function(role) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/ai-employees', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role, enabled: true })
    });
    if (typeof toast === 'function') toast('AI Employee hired ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.fireAIEmployee = async function(employeeId) {
  if (!confirm('Fire this AI employee?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/ai-employees/' + employeeId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('AI Employee fired');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.updateAIConfig = async function(employeeId, config) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/ai-employees/' + employeeId + '/config', {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    });
    if (typeof toast === 'function') toast('Config updated ✓');
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ══════════════════════════════════════════════════════════════════════════════

window.exportAnalytics = async function(timeframe) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    const response = await fetch(api + '/api/analytics/export?timeframe=' + (timeframe || '30d'), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'analytics_' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    if (typeof toast === 'function') toast('Analytics exported ✓');
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════════════════

window.updateSettings = async function(settings) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/settings', {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(settings)
    });
    if (typeof toast === 'function') toast('Settings saved ✓');
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.updateAPIKey = async function(keyName) {
  const value = prompt('Enter ' + keyName + ':');
  if (!value) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/settings/keys', {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ [keyName]: value })
    });
    if (typeof toast === 'function') toast('API key updated ✓');
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// FILE UPLOADS
// ══════════════════════════════════════════════════════════════════════════════

window.uploadImage = async function(onSuccess) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    try {
      const api = window._api ? window._api() : window.MINE_API;
      const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
      const response = await fetch(api + '/api/upload/image', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: formData
      });
      const data = await response.json();
      if (typeof toast === 'function') toast('Image uploaded ✓');
      if (onSuccess) onSuccess(data.url);
    } catch(e) {
      if (typeof toast === 'function') toast('Upload failed: ' + e.message);
    }
  };
  input.click();
};

window.uploadFile = async function(onSuccess) {
  const input = document.createElement('input');
  input.type = 'file';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const api = window._api ? window._api() : window.MINE_API;
      const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
      const response = await fetch(api + '/api/upload/file', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: formData
      });
      const data = await response.json();
      if (typeof toast === 'function') toast('File uploaded ✓');
      if (onSuccess) onSuccess(data.url);
    } catch(e) {
      if (typeof toast === 'function') toast('Upload failed: ' + e.message);
    }
  };
  input.click();
};

// ══════════════════════════════════════════════════════════════════════════════
// USERS MANAGEMENT (Admin)
// ══════════════════════════════════════════════════════════════════════════════

window.createUser = async function() {
  const email = prompt('User email:');
  if (!email) return;
  const password = prompt('Temporary password:');
  if (!password) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/users', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password, role: 'user' })
    });
    if (typeof toast === 'function') toast('User created ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.deleteUser = async function(userId) {
  if (!confirm('Delete this user?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/users/' + userId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('User deleted');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.updateUserRole = async function(userId, role) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/users/' + userId, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role })
    });
    if (typeof toast === 'function') toast('Role updated ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// AGENCY-SPECIFIC FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

window.createClient = async function() {
  const name = prompt('Client name:');
  if (!name) return;
  const email = prompt('Client email:');
  if (!email) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/agency/clients', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, email })
    });
    if (typeof toast === 'function') toast('Client added ✓');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

window.deleteClient = async function(clientId) {
  if (!confirm('Delete this client?')) return;
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    await fetch(api + '/api/agency/clients/' + clientId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (typeof toast === 'function') toast('Client deleted');
    if (typeof refreshPanel === 'function') refreshPanel();
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

window.refreshPanel = function() {
  // Reload current panel data
  const currentPanel = document.querySelector('.ni.on, .sb-item.on, .bot-nav-item.on');
  if (currentPanel) {
    const panelName = currentPanel.dataset.tab || currentPanel.dataset.panel;
    if (typeof goTo === 'function') goTo(panelName);
    else if (typeof showPanel === 'function') showPanel(panelName);
  }
};

window.confirmAction = function(message, callback) {
  if (confirm(message)) {
    if (typeof callback === 'function') callback();
  }
};

// Generic save function that can be used for various forms
window.saveFormData = async function(endpoint, formData) {
  try {
    const api = window._api ? window._api() : window.MINE_API;
    const token = window._tok ? window._tok() : localStorage.getItem('mine_token');
    const response = await fetch(api + endpoint, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(formData)
    });
    const data = await response.json();
    if (typeof toast === 'function') toast('Saved ✓');
    return data;
  } catch(e) {
    if (typeof toast === 'function') toast('Error: ' + e.message);
    throw e;
  }
};

console.log('✓ TAKEOVA API Integration loaded - All buttons ready for backend connection');
