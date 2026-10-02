import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ReportPreviewPage from './components/ReportPreviewPage';
import LiveWorkspace from './components/LiveWorkspace';
import './styles.css';

if (window.location.pathname === '/report-preview') document.title = '售后客服 Agent · 评测报告 | EvalPi';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{window.location.pathname === '/report-preview' ? <ReportPreviewPage /> : window.location.pathname === '/demo' ? <App /> : <LiveWorkspace />}</React.StrictMode>,
);
