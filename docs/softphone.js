(function () {
    var cfg = window.LAB_CONFIG;
    var calls = {}; // contactId -> { number, whoId, startedAt }
    var agentRef = null;
    var logEl = document.getElementById('log');
    function log(msg) {
        logEl.textContent += new Date().toLocaleTimeString() + '  ' + msg + '\n';
        logEl.scrollTop = logEl.scrollHeight;
    }
    // 1. Embed the Amazon Connect Contact Control Panel
    connect.core.initCCP(document.getElementById('ccp'), {
        ccpUrl: cfg.ccpUrl,
        region: cfg.region,
        loginPopup: true,
        loginPopupAutoClose: true,
        softphone: {
            allowFramedSoftphone: true
        }
    });
    connect.agent(function (agent) {
        agentRef = agent;
        log('Agent ready: ' + agent.getName());
    });
    // 2. Helpers
    function callerNumber(contact) {
        var conn = contact.getInitialConnection();
        var ep = conn && conn.getEndpoint();
        return ep ? ep.phoneNumber : null; // E.164, for example +61400000000
    }
    function attribute(contact, name) {
        var a = contact.getAttributes()[name];
        return a ? a.value : null;
    }

    function popNewContact(number) {
        sforce.opencti.screenPop({
            type: sforce.opencti.SCREENPOP_TYPE.NEW_RECORD_MODAL,
            params: {
                entityName: 'Contact',
                defaultFieldValues: {
                    LastName: 'Unknown caller',
                    Phone: number
                }
            }
        });
    }
    // 3. Inbound call: screen pop
    function onIncoming(contact) {
        if (!contact.isInbound()) {
            return;
        }
        var id = contact.getContactId();
        var number = callerNumber(contact);
        var sfContactId = attribute(contact, 'sfContactId'); 
        var sfCaseNumber = attribute(contact, 'caseNumber');
        calls[id] = {
            number: number,
            whoId: sfContactId,
            sfCaseNumber: sfCaseNumber,
            startedAt: null
        };
        log('Incoming call from ' + number);
        sforce.opencti.setSoftphonePanelVisibility({
            visible: true
        });
        if (sfContactId) { // exact match from the IVR lookup
            sforce.opencti.screenPop({
                type: sforce.opencti.SCREENPOP_TYPE.SOBJECT,
                params: {
                    recordId: sfContactId
                },
                callback: function (r) {
                    log('Pop by attribute: ' + r.success);
                }
            });
            return;
        }
        sforce.opencti.searchAndScreenPop({ // fallback: search by caller number
            searchParams: number,
            queryParams: '',
            callType: sforce.opencti.CALL_TYPE.INBOUND,
            deferred: false,
            callback: function (r) {
                if (!r.success) {
                    log('Search failed: ' + JSON.stringify(r.errors));
                    return;
                }
                var ids = Object.keys(r.returnValue || {});
                log('Matches: ' + ids.length);
                if (ids.length === 1) {
                    calls[id].whoId = ids[0];
                }
                if (ids.length === 0) {
                    popNewContact(number);
                }
            }
        });
    }

    function onConnected(contact) {
        var c = calls[contact.getContactId()];
        if (c) {
            c.startedAt = Date.now();
        }
    }
    // 4. Call ended: log a Task
    function onEnded(contact) {
        var id = contact.getContactId();
        var c = calls[id];
        if (!c) {
            return;
        }
        var seconds = c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000)
             : 0;
        var value = {
            entityApiName: 'Task',
            Subject: 'Inbound call from ' + c.number,
            Status: 'Completed',
            CallType: 'Inbound',
            CallDurationInSeconds: seconds,
            CallObject: id, // the Connect contact ID, so you can find duplicates
            Description: 'Amazon Connect contact ' + id + ', case: ' + (c.sfCaseNumber || 'N/A')
        };
        if (c.whoId) {
            value.WhoId = c.whoId;
        }
        sforce.opencti.saveLog({
            value: value,
            callback: function (r) {
                log(r.success ? 'Call logged' : 'Log failed: ' + JSON.stringify(r.errors));
                delete calls[id];
            }
        });
    }
    connect.contact(function (contact) {
        contact.onConnecting(function () {
            onIncoming(contact);
        });
        contact.onConnected(function () {
            onConnected(contact);
        });
        contact.onEnded(function () {
            onEnded(contact);
        });
    });
    // 5. Click-to-dial from any phone field in Salesforce
    sforce.opencti.enableClickToDial({
        callback: function (r) {
            log('Click-to-dial enabled: ' + r.success);
        }
    });
    sforce.opencti.onClickToDial({
        listener: function (payload) {

            sforce.opencti.setSoftphonePanelVisibility({
                visible: true
            });
            if (!agentRef) {
                log('Agent not ready');
                return;
            }
            log('Dialling ' + payload.number);
            agentRef.connect(connect.Endpoint.byPhoneNumber(payload.number), {
                success: function () {
                    log('Dial started');
                },
                failure: function (e) {
                    log('Dial failed: ' + e);
                }
            });
        }
    });
})();
