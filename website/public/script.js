document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const value = document.getElementById(button.dataset.copy)?.textContent;
    const status = button.parentElement.querySelector('.copy-status');
    if (!value || !status) return;
    try {
      await navigator.clipboard.writeText(value);
      status.textContent = 'Skopiowano.';
    } catch {
      status.textContent = 'Nie udało się skopiować. Zaznacz tekst i skopiuj go ręcznie.';
    }
  });
});
