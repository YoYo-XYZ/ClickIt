let chosen;
for (const button of document.querySelectorAll('.answers button')) button.addEventListener('click', () => {
  chosen = button.textContent;
  document.getElementById('result').textContent = '';
  for (const option of document.querySelectorAll('.answers button')) option.setAttribute('aria-pressed', String(option === button));
});
document.getElementById('submit').addEventListener('click', () => {
  document.getElementById('result').textContent = !chosen ? 'Choose an answer first.' : chosen === '4' ? 'Correct. 2 + 2 = 4.' : 'The correct answer is 4.';
});
