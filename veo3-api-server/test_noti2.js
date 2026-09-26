const { sendMessage, notifyPayment } = require('./src/telegram');
notifyPayment({ userId: 'test', tier: 'test', amount: 1000 }).then(() => console.log('Payment sent to group'));
sendMessage('Test error message for personal chat').then(() => console.log('Error sent to personal chat'));
