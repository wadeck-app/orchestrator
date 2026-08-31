import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useHeartbeat } from './hooks/useHeartbeat.js';
import { JobListPage } from './pages/JobListPage.js';
import { JobDetailPage } from './pages/JobDetailPage.js';
import { JobFormPage } from './pages/JobFormPage.js';
import { LogViewerPage } from './pages/LogViewerPage.js';

export default function App() {
  useHeartbeat();
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-50">
        <Routes>
          <Route path="/" element={<JobListPage />} />
          <Route path="/jobs/new" element={<JobFormPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/jobs/:id/edit" element={<JobFormPage />} />
          <Route path="/jobs/:id/logs" element={<LogViewerPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
