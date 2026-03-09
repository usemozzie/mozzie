import { Plus } from 'lucide-react';
import { useWorkItemStore } from '../../stores/workItemStore';
import { Button } from '../ui/button';
import { WorkItemList } from './WorkItemList';
import { NewWorkItemModal } from './NewWorkItemModal';

export function WorkItemPanel() {
  const {
    isNewWorkItemModalOpen,
    newWorkItemContextSeed,
    openNewWorkItemModal,
    closeNewWorkItemModal,
  } = useWorkItemStore();

  return (
    <div className="flex flex-col h-full bg-bg border-r border-border" style={{ minWidth: 240, maxWidth: 500 }}>
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <h1 className="text-[13px] font-semibold text-text tracking-tight">Work Items</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          title="New Work Item"
          onClick={() => openNewWorkItemModal()}
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Content — full height work item list */}
      <div className="flex-1 min-h-0">
        <WorkItemList />
      </div>

      {isNewWorkItemModalOpen && (
        <NewWorkItemModal
          onClose={closeNewWorkItemModal}
          initialContext={newWorkItemContextSeed}
        />
      )}
    </div>
  );
}
