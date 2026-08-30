import { X } from "lucide-react";

export function Modal({
  title, onClose, children, wide = false,
}: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4">
      <div
        className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} bg-white rounded-xl border border-border shadow-xl max-h-[90vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="font-display font-bold text-[16px] text-foreground">{title}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-secondary text-muted-foreground transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
