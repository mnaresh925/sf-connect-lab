public with sharing class ConnectDialer {

    @AuraEnabled
    public static String dial(String toNumber, Id contactId) {
        if (String.isBlank(toNumber) || !Pattern.matches('^\\+[0-9]{6,15}$', toNumber)) {
            throw new AuraHandledException('Use E.164 format, for example +61400000000');
        }
        Connect_Setting__mdt cfg = Connect_Setting__mdt.getInstance('Default');
        if (cfg == null) {
            throw new AuraHandledException('Connect_Setting Default record is missing');
        }

        Map<String, Object> body = new Map<String, Object>{
            'InstanceId' => cfg.Instance_Id__c,
            'ContactFlowId' => cfg.Contact_Flow_Id__c,
            'DestinationPhoneNumber' => toNumber,
            'SourcePhoneNumber' => cfg.Source_Number__c,
            'Attributes' => new Map<String, String>{
                'sfContactId' => contactId == null ? '' : String.valueOf(contactId),
                'initiatedBy' => UserInfo.getUserId()
            }
        };

        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Amazon_Connect_API/contact/outbound-voice');
        req.setMethod('PUT');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(10000);
        req.setBody(JSON.serialize(body));

        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() != 200) {
            System.debug(LoggingLevel.ERROR, 'Connect error ' + res.getStatusCode() + ' ' + res.getBody());
            throw new AuraHandledException('Amazon Connect returned status ' + res.getStatusCode());
        }
        Map<String, Object> out = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        return (String) out.get('ContactId');
    }
}