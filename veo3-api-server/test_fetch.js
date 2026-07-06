async function test() {
  try {
    const res = await fetch('https://flow-content.google/video/123');
    console.log(res.status);
  } catch (e) {
    console.error(e.message);
  }
}
test();
