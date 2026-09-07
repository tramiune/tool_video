with open("flow-extension/background.js", "r") as f:
    bg = f.read()

# Replace all occurrences of world: "MAIN" with world: "ISOLATED"
bg = bg.replace('world: "MAIN"', 'world: "ISOLATED"')

with open("flow-extension/background.js", "w") as f:
    f.write(bg)

print("done")
