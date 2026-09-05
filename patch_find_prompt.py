import re

with open("flow-extension/background.js", "r") as f:
    bg = f.read()

# Replace the editor finding logic for BOTH Step 1 and Step 4.7/4.8
# Wait, let's fix the specific block in Step 4.7/4.8 first.
old_block = """                let editor = editors.length > 0 ? editors[0] : null;
                const activePrompt = editors.find(e => {
                  const ph = (e.getAttribute("placeholder") || "").toLowerCase();
                  return ph.includes("prompt") || e.classList.contains("ProseMirror");
                });
                if (activePrompt) editor = activePrompt;

                // SPECIAL FOR KHUNG HÌNH: The prompt editor is actually INSIDE the settings popover!
                const activePopover = queryDeep("div[role='dialog'], div[data-radix-popper-content-wrapper], div[class*='popover']").find(d => {
                  if (!isElemVisible(d)) return false;
                  const t = d.textContent || "";
                  return (t.includes("9:16") || t.includes("16:9") || t.includes("Bạn muốn tạo"));
                });
                
                if (activePopover) {
                  const popoverEditors = queryScopeDeep(activePopover, "div.ProseMirror, div[contenteditable='true'], textarea, input[type='text']").filter(isElemVisible);
                  if (popoverEditors.length > 0) {
                     editor = popoverEditors[0];
                     const innerPrompt = popoverEditors.find(e => {
                        const ph = (e.getAttribute("placeholder") || "").toLowerCase();
                        return ph.includes("bạn muốn tạo") || e.classList.contains("ProseMirror");
                     });
                     if (innerPrompt) editor = innerPrompt;
                  }
                }"""

new_block = """                const findCorrectPrompt = (list) => {
                    return list.find(e => {
                        const ph = (e.getAttribute("placeholder") || "").toLowerCase();
                        const aria = (e.getAttribute("aria-label") || "").toLowerCase();
                        return ph.includes("bạn muốn tạo") || ph.includes("prompt") || aria.includes("prompt") || e.classList.contains("ProseMirror") || e.tagName.toLowerCase() === "textarea";
                    });
                };

                // Lọc bỏ search bar trên cùng
                const validEditors = editors.filter(e => {
                    const ph = (e.getAttribute("placeholder") || "").toLowerCase();
                    return !ph.includes("tìm kiếm") && !ph.includes("search");
                });

                let editor = findCorrectPrompt(validEditors) || (validEditors.length > 0 ? validEditors[validEditors.length - 1] : null);

                // Ưu tiên popover nếu nó đang mở
                const activePopover = queryDeep("div[role='dialog'], div[data-radix-popper-content-wrapper], div[class*='popover']").find(d => {
                  if (!isElemVisible(d)) return false;
                  const t = d.textContent || "";
                  return (t.includes("9:16") || t.includes("16:9") || t.includes("Bạn muốn tạo"));
                });
                
                if (activePopover) {
                  const popoverEditors = queryScopeDeep(activePopover, "div.ProseMirror, div[contenteditable='true'], textarea, input[type='text']").filter(isElemVisible);
                  const validPopoverEditors = popoverEditors.filter(e => !e.getAttribute("placeholder")?.toLowerCase().includes("tìm kiếm"));
                  if (validPopoverEditors.length > 0) {
                     const innerPrompt = findCorrectPrompt(validPopoverEditors);
                     if (innerPrompt) editor = innerPrompt;
                     else editor = validPopoverEditors[validPopoverEditors.length - 1];
                  }
                }"""

bg = bg.replace(old_block, new_block)

# Also fix Step 1 logic
old_step1_editor = """              const activePrompt = editors.find(e => {
                const id = (e.getAttribute("id") || "").toLowerCase();
                const ph = (e.getAttribute("placeholder") || "").toLowerCase();
                const aria = (e.getAttribute("aria-label") || "").toLowerCase();
                return id.includes("prompt") || ph.includes("prompt") || aria.includes("prompt") || e.classList.contains("ProseMirror");
              });
              if (activePrompt) editor = activePrompt;"""

new_step1_editor = """              const activePrompt = editors.find(e => {
                const ph = (e.getAttribute("placeholder") || "").toLowerCase();
                const aria = (e.getAttribute("aria-label") || "").toLowerCase();
                return ph.includes("bạn muốn tạo") || ph.includes("prompt") || aria.includes("prompt") || e.classList.contains("ProseMirror") || e.tagName.toLowerCase() === "textarea";
              });
              if (activePrompt) editor = activePrompt;
              
              // Loại bỏ search box nếu là fallback
              if (!activePrompt && editors.length > 0) {
                 const nonSearch = editors.filter(e => !(e.getAttribute("placeholder")||"").toLowerCase().includes("tìm kiếm"));
                 if (nonSearch.length) editor = nonSearch[nonSearch.length - 1];
              }"""

bg = bg.replace(old_step1_editor, new_step1_editor)

with open("flow-extension/background.js", "w") as f:
    f.write(bg)
print("done")
