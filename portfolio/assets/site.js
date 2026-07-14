const toggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('.site-nav');
const projectsMenu = document.querySelector('.projects-menu');
if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    nav.classList.toggle('is-open', !open);
  });
  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      toggle.setAttribute('aria-expanded', 'false');
      nav.classList.remove('is-open');
    }
  });
}
document.addEventListener('click', (event) => {
  if (projectsMenu?.open && !projectsMenu.contains(event.target)) projectsMenu.open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (projectsMenu) projectsMenu.open = false;
    if (toggle && nav) {
      toggle.setAttribute('aria-expanded', 'false');
      nav.classList.remove('is-open');
    }
  }
});
