/** Redistributable self-contained contract for examples and conformance tests. */
export const ordersWsdl = `<?xml version="1.0"?>
<w:definitions xmlns:w="http://schemas.xmlsoap.org/wsdl/" xmlns:s="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:x="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:orders" targetNamespace="urn:orders">
<w:types><x:schema targetNamespace="urn:orders" elementFormDefault="qualified">
<x:element name="GetOrder"><x:complexType><x:sequence><x:element name="id" type="x:string"/></x:sequence></x:complexType></x:element>
<x:element name="GetOrderResponse"><x:complexType><x:sequence><x:element name="total" type="x:decimal"/><x:element name="paid" type="x:boolean"/></x:sequence></x:complexType></x:element>
</x:schema></w:types>
<w:message name="Request"><w:part name="body" element="t:GetOrder"/></w:message>
<w:message name="Response"><w:part name="body" element="t:GetOrderResponse"/></w:message>
<w:portType name="OrdersPortType"><w:operation name="GetOrder"><w:input message="t:Request"/><w:output message="t:Response"/></w:operation></w:portType>
<w:binding name="OrdersBinding" type="t:OrdersPortType"><s:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/><w:operation name="GetOrder"><s:operation soapAction="urn:getOrder"/><w:input><s:body use="literal"/></w:input><w:output><s:body use="literal"/></w:output></w:operation></w:binding>
<w:service name="Orders"><w:port name="OrdersPort" binding="t:OrdersBinding"><s:address location="https://example.com/orders"/></w:port></w:service>
</w:definitions>`;
