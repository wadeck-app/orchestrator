import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { GenericPageRunner } from '@wadeck-app/dsl-renderer';
import { ToastProvider } from '@wadeck-app/dsl-ui';
import { appRegistry } from './registry.js';
import { fetcher } from './fetcher.js';
import { dslRoutes } from './generated/routes.js';
import { FailureBanner, NavBar, useFailures } from '@wadeck-app/orch-ui';

export default function App(): React.ReactElement {
  const { failures, acknowledgeOne, acknowledgeAll } = useFailures();
  return (
    // ToastProvider wraps the router, so a toast raised by any page - including one raised on mount
    // from a flash left behind by a redirect - has somewhere to render. MutationFeedback throws
    // without it, which is deliberate: a silent no-op notification is worse than none.
    <ToastProvider>
      <BrowserRouter>
      <div className="min-h-screen bg-bg">
        <NavBar />
        <FailureBanner failures={failures} onAcknowledge={acknowledgeOne} onAcknowledgeAll={acknowledgeAll} />
        <Routes>
          {dslRoutes.map(r => (
            <Route key={r.route} path={r.route} element={<GenericPageRunner yamlText={r.yamlText} registry={appRegistry} fetcher={fetcher} />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      </BrowserRouter>
    </ToastProvider>
  );
}
