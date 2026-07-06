const fetch = require('node-fetch');

async function testWebhook() {
  const payload = {
    error: 0,
    data: [
      {
        id: 123456,
        tid: "TEST_TID_9999",
        description: "Nguyen Van A chuyen khoan VE123456",
        amount: 99000,
        cusum_balance: 1000000,
        when: "2023-10-10 10:10:10"
      }
    ]
  };

  try {
    const res = await fetch('http://localhost:3456/api/payment-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    console.log("Webhook Response:", result);
  } catch (e) {
    console.error("Lỗi:", e);
  }
}

testWebhook();
