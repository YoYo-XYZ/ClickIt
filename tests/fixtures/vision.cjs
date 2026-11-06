module.exports = `<!doctype html><style>
body{margin:0;min-height:1400px;background:white;color:black;font:24px Arial}
#question{position:absolute;left:40px;top:80px;width:min(600px,calc(100vw - 80px));height:120px}
#choices{position:absolute;left:40px;top:260px;width:min(600px,calc(100vw - 80px));height:200px;display:grid;grid-template-columns:1fr 1fr;gap:20px}
button{font:24px Arial;background:#dae8ff;border:2px solid #314669;color:black}
#submit{position:absolute;left:40px;top:520px;width:160px;height:60px}
#timer{position:absolute;right:20px;top:10px}
</style><div id="timer">20</div><div id="question">What is 2 + 2?</div>
<div id="choices"><button id="option1">1</button><button id="option2">2</button><button id="option3">3</button><button id="option4">4</button></div><button id="submit">Submit</button>
<script>window.clicks=[];window.submissions=0;document.addEventListener('click',e=>{if(e.target.id.startsWith('option'))clicks.push(e.target.textContent);if(e.target.id==='submit')submissions++});</script>`;
