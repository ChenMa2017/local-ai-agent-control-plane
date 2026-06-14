"use strict";

function renderControlPanelClientScript() {
  return `
    const vscode = acquireVsCodeApi();
    const post = (command, payload = {}) => vscode.postMessage({ command, ...payload });
    const selectedRoot = document.body.dataset.selectedRoot || '';
    const rootInput = document.getElementById('root');
    const pendingRootHint = document.getElementById('pendingRootHint');
    const selectedOnlySections = Array.from(document.querySelectorAll('.selected-only'));
    const syncDraftRoot = () => {
      const draftRoot = rootInput.value.trim();
      const changed = !selectedRoot || draftRoot !== selectedRoot;
      pendingRootHint.hidden = selectedRoot ? !changed : !draftRoot;
      selectedOnlySections.forEach((section) => {
        section.style.display = changed ? 'none' : '';
      });
    };
    rootInput.addEventListener('input', syncDraftRoot);
    syncDraftRoot();
    document.getElementById('chooseRoot').addEventListener('click', () => post('chooseRoot'));
    document.getElementById('browseRoot').addEventListener('click', () => post('browseRoot', { root: rootInput.value }));
    document.getElementById('saveRoot').addEventListener('click', () => post('saveRoot', { root: rootInput.value }));
    document.getElementById('clearRoot').addEventListener('click', () => post('clearRoot'));
    document.getElementById('refresh').addEventListener('click', () => post('refresh'));
    document.getElementById('login').addEventListener('click', () => post('login'));
    document.getElementById('saveInterval').addEventListener('click', () => post('saveInterval', {
      intervalMinutes: document.getElementById('interval').value,
      compactEveryRuns: document.getElementById('compactEveryRuns').value
    }));
    document.getElementById('prepareProject').addEventListener('click', () => post('prepareProject'));
    const bootstrapPrompt = document.getElementById('bootstrapPrompt');
    const sendBootstrapPrompt = () => post('generateBootstrap', {
      text: bootstrapPrompt.value
    });
    document.getElementById('generateBootstrap').addEventListener('click', sendBootstrapPrompt);
    bootstrapPrompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendBootstrapPrompt();
      }
    });
    document.getElementById('instantiateBootstrapProject').addEventListener('click', () => post('instantiateBootstrapProject'));
    document.getElementById('openSetupFiles').addEventListener('click', () => post('openSetupFiles'));
    document.getElementById('openBootstrapTranscript').addEventListener('click', () => post('openBootstrapTranscript'));
    document.getElementById('openBootstrapPreview').addEventListener('click', () => post('openBootstrapPreview'));
    document.getElementById('resetBootstrapConversation').addEventListener('click', () => post('resetBootstrapConversation'));
    document.getElementById('startGuard').addEventListener('click', () => post('startGuard'));
    document.getElementById('pauseGuard').addEventListener('click', () => post('pauseGuard'));
    document.getElementById('resumeGuard').addEventListener('click', () => post('resumeGuard'));
    document.getElementById('stopGuard').addEventListener('click', () => post('stopGuard'));
    document.getElementById('runOnce').addEventListener('click', () => post('runOnce'));
    document.getElementById('startTimer').addEventListener('click', () => post('startTimer'));
    document.getElementById('stopTimer').addEventListener('click', () => post('stopTimer'));
    document.getElementById('refreshGenerated').addEventListener('click', () => post('refreshGenerated'));
    document.getElementById('openLatest').addEventListener('click', () => post('openLatest'));
    document.getElementById('openMorning').addEventListener('click', () => post('openMorning'));
`;
}

module.exports = {
  renderControlPanelClientScript
};
