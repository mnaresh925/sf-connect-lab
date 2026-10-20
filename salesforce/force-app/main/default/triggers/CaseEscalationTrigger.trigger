trigger CaseEscalationTrigger on Case (after update) {
    List<Case_Escalated__e> events = new List<Case_Escalated__e>();
    for (Case c : Trigger.new) {
        Case old = Trigger.oldMap.get(c.Id);
        if (c.IsEscalated && !old.IsEscalated) {
            events.add(new Case_Escalated__e(
                Case_Id__c = c.Id,
                Priority__c = c.Priority,
                Subject__c = c.Subject
            ));
        }
    }
    if (!events.isEmpty()) {
        for (Database.SaveResult r : EventBus.publish(events)) {
            if (!r.isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Publish failed: ' + r.getErrors());
            }
        }
    }
}