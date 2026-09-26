const { sendMessage } = require('./src/telegram');
sendMessage('✅ <b>Bot Meo3</b> đã kết nối thành công vào group theo lệnh của sếp!').then(r => console.log('Sent:', r));
