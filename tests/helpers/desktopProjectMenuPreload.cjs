// Synthetic project list; never opens real projects or user configuration.
require("./desktopIdlePreload.cjs");
const projects = Array.from({ length: 30 }, (_, index) => ({
  id: `fixture-${index}`, name: `Project ${index + 1}`, kind: "single",
  root: `/fixture/${index}`, saved: true, sessions: [],
  repos: [{ id: "repo-0", name: `Project ${index + 1}`, cwd: `/fixture/${index}` }],
}));
window.cloudcode.restoreProjects = async () => projects;
window.cloudcode.refreshWorkspace = async id => projects.find(project => project.id === id);
window.cloudcode.gitState = async () => ({ isGitRepo: false, ahead: 0, behind: 0, files: [], recent: [], truncated: false });
window.cloudcode.gitBranches = async () => [];
window.cloudcode.removeWorkspace = async id => {
  const index = projects.findIndex(project => project.id === id);
  if (index !== -1) projects.splice(index, 1);
};
