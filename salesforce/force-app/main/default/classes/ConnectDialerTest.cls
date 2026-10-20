@IsTest
private class ConnectDialerTest {

    private class OkMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            System.assertEquals('PUT', req.getMethod());
            System.assert(req.getEndpoint().contains('/contact/outbound-voice'));
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setBody('{"ContactId":"abc-123"}');
            return res;
        }
    }

    private class FailMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(403);
            res.setBody('{"message":"denied"}');
            return res;
        }
    }

    @IsTest static void returnsContactIdOnSuccess() {
        Test.setMock(HttpCalloutMock.class, new OkMock());
        Test.startTest();
        String id = ConnectDialer.dial('+61400000000', null);
        Test.stopTest();
        System.assertEquals('abc-123', id);
    }

    @IsTest static void rejectsBadNumber() {
        Boolean thrown = false;
        try { ConnectDialer.dial('0400', null); }
        catch (AuraHandledException e) { thrown = true; }
        System.assert(thrown, 'A non E.164 number must be rejected');
    }

    @IsTest static void surfacesFailure() {
        Test.setMock(HttpCalloutMock.class, new FailMock());
        Boolean thrown = false;
        Test.startTest();
        try { ConnectDialer.dial('+61400000000', null); }
        catch (AuraHandledException e) { thrown = true; }
        Test.stopTest();
        System.assert(thrown, 'A 403 must surface as an error');
    }
}