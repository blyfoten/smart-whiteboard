// src/output.js — the result/output panel (moved out of the inline HTML script).
// Owns the "Solution Output" panel: appending result cards, clearing, and the
// mobile collapse toggle.

export function appendToOutput(content, isError = false) {
  const outputContent = document.getElementById('output-content');
  if (!outputContent) return;

  const resultBlock = document.createElement('div');
  resultBlock.className = isError ? 'result-block error-block' : 'result-block';
  resultBlock.innerHTML = content;

  const timestamp = document.createElement('div');
  timestamp.style.fontSize = '11px';
  timestamp.style.color = '#777';
  timestamp.style.marginTop = '5px';
  timestamp.textContent = new Date().toLocaleTimeString();
  resultBlock.appendChild(timestamp);

  outputContent.appendChild(resultBlock);
  outputContent.scrollTop = outputContent.scrollHeight;
}

export function initOutputPanel() {
  const clearBtn = document.getElementById('clear-output');
  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const outputContent = document.getElementById('output-content');
      if (outputContent) outputContent.innerHTML = 'Output cleared.';
    });
  }

  const title = document.querySelector('.output-title');
  const panel = document.getElementById('output-panel');
  if (title && panel) {
    title.addEventListener('click', () => panel.classList.toggle('collapsed'));
    if (window.innerWidth <= 768) panel.classList.add('collapsed');
  }

  // Back-compat: some code paths reference window.appendToOutput.
  window.appendToOutput = appendToOutput;
}
