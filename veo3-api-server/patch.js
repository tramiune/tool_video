const fs = require('fs');
const code = fs.readFileSync('src/server.js', 'utf8');

let newCode = code.replace(
  /throw e;\s*\}\s*\}\s*logger\.info\(`\[Image\] Starting task: \$\{taskId\} \(active workers: \$\{activeImageWorkers\}\)`\);/g,
  `throw e;\n      }\n    } else {\n      throw new Error("Extension Bridge bị ngắt kết nối. Vui lòng mở hoặc tải lại tab Bulk AI Studio và chờ 5 giây.");\n    }\n\n    /*`
);

newCode = newCode.replace(
  /throw failureError;\s*\}\s*\}\s*catch\s*\(err\)/g,
  `throw failureError;\n    }\n    */\n\n  } catch (err)`
);

fs.writeFileSync('src/server.js', newCode);
console.log("Patched!");
