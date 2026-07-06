const http = require('http');

const prompts = [
  "a lone samurai standing in cherry blossom rain, cinematic, 4k",
  "neon-lit Tokyo street at night, rain reflections, cyberpunk",
  "deep ocean trench with bioluminescent creatures, ethereal glow",
  "ancient dragon perched on a mountain peak at sunrise",
  "cozy autumn cottage surrounded by golden maple trees",
  "astronaut floating in space above a vibrant nebula",
  "a wolf howling at a full moon over snowy mountains",
  "steampunk airship sailing through stormy golden clouds",
  "underwater ruins of a lost city with tropical fish",
  "a mystical forest with glowing mushrooms and fireflies",
  "futuristic megacity skyline at dusk, flying cars",
  "a field of lavender stretching to the horizon, golden hour",
  "an ancient library with floating books and magical light",
  "a polar bear on a floating ice sheet, aurora borealis",
  "a phoenix rising from flames, dramatic lighting",
  "waterfall in a tropical rainforest, misty morning",
  "a tiny house on a cliff overlooking the stormy sea",
  "marble Greek temple ruins at golden hour",
  "a giant whale swimming above the clouds",
  "enchanted castle on a floating island, sunset",
  "a street market in Marrakech, vibrant colors, top-down view",
  "close-up of a dewdrop on a spider web at dawn",
  "a black cat sitting on a moonlit fence, mystical",
  "hot air balloons over Cappadocia at sunrise",
  "a robot tending to a garden of glowing flowers",
  "storm clouds over a wheat field, dramatic sky",
  "a mermaid resting on ocean rocks, golden sunlight",
  "viking longship sailing through a fjord, misty morning",
  "a vintage train winding through the Alps in autumn",
  "a secret garden behind a ivy-covered stone wall",
  "a samurai cat warrior in full armor, dramatic pose",
  "ethereal fairy sitting on a giant mushroom, macro",
  "an abandoned lighthouse on a rocky coast at stormy sunset",
  "northern lights reflected on a frozen lake",
  "a street in Santorini at blue hour, whitewashed walls",
  "a futuristic laboratory with holographic displays",
  "a red panda in a bamboo forest, cute and fluffy",
  "pirate ship in a bottle on a beach at sunset",
  "a comet streaking across a star-filled night sky",
  "a jazz musician playing trumpet in rainy New York streets",
  "butterflies emerging from a cracked egg, surreal art",
  "a crystal cave with glowing stalactites and underground lake",
  "an old woman knitting in a cozy firelit library",
  "a mechanical heart made of gears and roses",
  "storm lightning striking the Eiffel Tower at night",
  "a baby elephant playing in monsoon rain, joyful",
  "aerial view of rice terraces in Bali at sunrise",
  "a lone cabin in an autumn forest, wood smoke rising",
  "a sugar skull made of flowers, Day of the Dead",
  "an old film camera surrounded by vintage polaroids",
  "a koi pond with lotus flowers, zen garden",
  "deep jungle temple ruins covered in vines and moss",
  "a knight in shining armor standing in foggy moor",
  "a magical treehouse village in a giant ancient tree",
  "a glowing orb floating in a misty enchanted forest",
  "close-up of a lion's eyes, intense and golden",
  "a chef plating a Michelin-star dish, elegant presentation",
  "a girl reading a book under a rainbow umbrella in rain",
  "a black horse galloping on a foggy beach at dawn",
  "an hourglass filled with tiny glowing stars instead of sand",
  "a coral reef teeming with tropical fish, vibrant colors",
  "a futuristic soldier in neon-lit ruins, sci-fi",
  "cherry blossom trees along a winding river path, spring",
  "a crystal ball showing a tiny city inside, macro",
  "a haunted Victorian mansion on Halloween night",
  "a sea turtle gliding through turquoise tropical water",
  "a marketplace in ancient Rome, bustling with life",
  "a golden retriever puppy playing in autumn leaves",
  "a wormhole opening in deep space, swirling energy",
  "a sushi chef crafting intricate rolls, top-down shot",
  "rain falling on a calm lake surface at dusk, ripples",
  "a wolf pack howling together at the aurora borealis",
  "a sunflower field stretching to the horizon, summer",
  "an old map with a glowing X marking treasure location",
  "a city carved into a giant glacier, sci-fi architecture",
  "a hummingbird hovering over a tropical flower, macro",
  "abandoned amusement park overgrown with nature at sunset",
  "a samurai warrior standing in a bamboo forest, mist",
  "a child blowing dandelion seeds, magical golden light",
  "an owl perched on a lantern in a snowy night",
  "abstract geometric art in neon colors, symmetrical mandala",
  "a coastal village in Norway with colorful wooden houses",
  "a fox kit peeking from behind autumn leaves, cute",
  "an ancient clocktower at midnight, gears and cogs exposed",
  "a watercolor painting of Paris rooftops in spring rain",
  "a space colony on Mars with domed habitats",
  "a black panther stalking through a misty jungle",
  "a medieval tavern interior with fireplace and adventurers",
  "a sunken pirate ship with coral and fish, underwater",
  "a mother bear and two cubs fishing in a river",
  "an elf archer in an ancient enchanted forest",
  "a lighthouse beam cutting through thick ocean fog",
  "a glassblower creating an intricate glass sculpture",
  "a minimalist Japanese room with paper screens, zen",
  "a storm chaser truck racing toward a massive tornado",
  "a galaxy reflected in a desert salt flat at night",
  "a chameleon camouflaged among tropical leaves, macro",
  "a vintage coffee shop interior, warm bokeh lights",
  "a sandstorm engulfing ancient Egyptian pyramids at dusk",
  "a wizard's tower at the edge of a cliff, stormy night",
];

const SERVER = 'http://localhost:3456';

function postJSON(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'localhost',
      port: 3456,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve(body); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log(`🚀 Gửi ${prompts.length} yêu cầu tạo ảnh lên server...\n`);
  const taskIds = [];
  const start = Date.now();

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    try {
      const res = await postJSON('/api/generate-image', {
        prompt,
        model: 'nano_banana_2',
        aspectRatio: '1:1'
      });
      if (res.taskId) {
        taskIds.push({ idx: i + 1, taskId: res.taskId, prompt: prompt.substring(0, 40) });
        process.stdout.write(`✅ [${i+1}/100] Queued: ${prompt.substring(0,45)}...\n`);
      } else {
        process.stdout.write(`❌ [${i+1}/100] FAILED: ${JSON.stringify(res).substring(0,80)}\n`);
      }
    } catch (e) {
      process.stdout.write(`❌ [${i+1}/100] ERROR: ${e.message}\n`);
    }
    // Small delay to not overwhelm queue endpoint itself
    await new Promise(r => setTimeout(r, 50));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n📋 Đã gửi ${taskIds.length}/${prompts.length} task trong ${elapsed}s`);
  console.log(`📺 Xem tiến trình tại: http://localhost:3456\n`);
  console.log('Task IDs:', taskIds.map(t => t.taskId).join(', '));
}

main().catch(console.error);
