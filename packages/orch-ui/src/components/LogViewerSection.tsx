import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { LogViewer } from './LogViewer.js';

interface Props {
  jobId: string;
}

/**
 * @registryCategory composite
 * @registryTags log viewer streaming
 */
export function LogViewerSection({ jobId }: Props): React.ReactElement {
  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 200px)' }}>
      <div className="flex items-center gap-4 mb-3">
        <Link to={`/jobs/${jobId}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-content mb-4">
          <ArrowLeft size={14} />Back
        </Link>
        <span className="text-sm font-medium text-content">Logs: {jobId}</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <LogViewer jobId={jobId} />
      </div>
    </div>
  );
}
