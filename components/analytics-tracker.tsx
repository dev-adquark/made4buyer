"use client";
import{useEffect}from"react";
function sessionId(){try{const key="made4buyers_session";let id=localStorage.getItem(key);if(!id){id=crypto.randomUUID();localStorage.setItem(key,id)}return id}catch{return undefined}}
export default function AnalyticsTracker({reviewId,category,event="page_view"}:{reviewId?:string;category?:string;event?:"page_view"|"review_view"}){useEffect(()=>{fetch("/api/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reviewId,category,event,sessionId:sessionId()})}).catch(()=>{});},[reviewId,category,event]);return null}
