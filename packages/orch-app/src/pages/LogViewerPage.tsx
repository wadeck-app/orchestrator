import { useParams, Link } from 'react-router-dom';
import { LogViewer } from '@wadeck-app/orch-ui';

export function LogViewerPage() {
  const { id } = useParams<{ id: string }>();

  if (!id) return <p className="p-4 text-red-600">No job ID.</p>;

  return (
    <div className="flex flex-col h-screen">
      <div className="flex items-center gap-4 px-4 py-3 bg-white border-b border-gray-200 shrink-0">
        <Link to={`/jobs/${id}`} className="text-sm text-blue-600 hover:underline">
          &larr; Back to job
        </Link>
        <h1 className="text-sm font-medium text-gray-700">Logs: {id}</h1>
      </div>
      <div className="flex-1 overflow-hidden">
        <LogViewer jobId={id} />
      </div>
    </div>
  );
}
