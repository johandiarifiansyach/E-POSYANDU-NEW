import Native from '../runtime/dom';
import { ChevronLeft, ChevronRight } from '../ui/icons';

type IosPaginationProps = {
    currentPage: number;
    totalPages: number;
    disablePrevious?: boolean;
    disableNext?: boolean;
    onPrevious: () => void;
    onNext: () => void;
};

export default function IosPagination({
    currentPage,
    totalPages,
    disablePrevious = false,
    disableNext = false,
    onPrevious,
    onNext
}: IosPaginationProps) {
    return (Native.createElement("nav", { className: "ios-pagination", "aria-label": "Navigasi halaman tabel" },
        Native.createElement("button", { type: "button", className: "ios-pagination-button", disabled: disablePrevious, onClick: onPrevious, title: "Halaman sebelumnya", "aria-label": "Kembali ke halaman sebelumnya" },
            Native.createElement(ChevronLeft, { className: "h-4 w-4", "aria-hidden": "true" }),
            Native.createElement("span", null, "Kembali")),
        Native.createElement("span", { className: "ios-page-indicator", "aria-current": "page" },
            Native.createElement("span", { className: "ios-page-indicator-label" }, "Halaman"),
            Native.createElement("strong", null, currentPage),
            Native.createElement("span", { "aria-hidden": "true" }, "/"),
            Native.createElement("span", null, Math.max(1, totalPages))),
        Native.createElement("button", { type: "button", className: "ios-pagination-button", disabled: disableNext, onClick: onNext, title: "Halaman berikutnya", "aria-label": "Lanjut ke halaman berikutnya" },
            Native.createElement("span", null, "Berikutnya"),
            Native.createElement(ChevronRight, { className: "h-4 w-4", "aria-hidden": "true" }))));
}
