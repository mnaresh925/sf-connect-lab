import { LightningElement, track } from 'lwc';
import { subscribe, unsubscribe, onError } from 'lightning/empApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

const PRIORITY_CLASS_MAP = {
    Critical : 'priority-badge priority-critical',
    High     : 'priority-badge priority-high',
    Medium   : 'priority-badge priority-medium',
    Low      : 'priority-badge priority-low'
};

/** Return a human-readable relative time string */
function timeAgo(date) {
    const seconds = Math.floor((Date.now() - date) / 1000);
    if (seconds < 60)  return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
}

export default class EscalationBanner extends LightningElement {
    channel = '/event/Case_Escalated__e';
    subscription = null;
    _tickInterval = null;

    @track escalatedCases = [];

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    connectedCallback() {
        onError((error) => console.error('empApi error', JSON.stringify(error)));
        subscribe(this.channel, -1, (message) => this.handleEvent(message))
            .then((sub) => { this.subscription = sub; });

        // Refresh relative timestamps every 60 s
        this._tickInterval = setInterval(() => this._refreshTimeAgo(), 60000);
    }

    disconnectedCallback() {
        if (this.subscription) { unsubscribe(this.subscription, () => {}); }
        if (this._tickInterval) { clearInterval(this._tickInterval); }
    }

    // ─── Getters ──────────────────────────────────────────────────────────────

    get hasEscalations() {
        return this.escalatedCases.length > 0;
    }

    // ─── Event handlers ───────────────────────────────────────────────────────

    handleEvent(message) {
        const p = message.data.payload;
        const now = Date.now();

        // Show toast
        this.dispatchEvent(new ShowToastEvent({
            title   : 'Case Escalated',
            message : `${p.Subject__c} (Priority: ${p.Priority__c})`,
            variant : 'warning',
            mode    : 'sticky'
        }));

        // Add to the list
        const priority = p.Priority__c || 'Medium';
        const newCase = {
            id          : `${now}-${Math.random()}`,
            subject     : p.Subject__c    || 'Untitled Case',
            priority,
            caseNumber  : p.CaseNumber__c || null,
            caseId      : p.CaseId__c     || null,
            timestamp   : now,
            timeAgo     : 'just now',
            priorityClass: PRIORITY_CLASS_MAP[priority] || PRIORITY_CLASS_MAP.Medium
        };

        // Most-recent first
        this.escalatedCases = [newCase, ...this.escalatedCases];
    }

    dismissCase(event) {
        const id = event.currentTarget.dataset.id;
        this.escalatedCases = this.escalatedCases.filter(c => c.id !== id);
    }

    clearAll() {
        this.escalatedCases = [];
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    _refreshTimeAgo() {
        this.escalatedCases = this.escalatedCases.map(c => ({
            ...c,
            timeAgo: timeAgo(c.timestamp)
        }));
    }
}