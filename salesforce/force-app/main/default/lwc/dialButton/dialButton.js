import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import MOBILE from '@salesforce/schema/Contact.MobilePhone';
import dial from '@salesforce/apex/ConnectDialer.dial';

export default class DialButton extends LightningElement {
  @api recordId;

  @wire(getRecord, { recordId: '$recordId', fields: [MOBILE] })
  contact;

  async handleDial() {
    const number = getFieldValue(this.contact.data, MOBILE);
    try {
      await dial({ toNumber: number, contactId: this.recordId });
      this.toast('Calling', 'Amazon Connect is calling ' + number, 'success');
    } catch (e) {
      this.toast('Call failed', e.body ? e.body.message : e.message, 'error');
    }
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}