"use client";
import{useEffect}from"react";
type EventName="page_view"|"review_view"|"compare"|"search";
function sessionId(){try{const key="made4buyers_session";let id=localStorage.getItem(key);if(!id){id=crypto.randomUUID();localStorage.setItem(key,id)}document.cookie="made4buyers_session="+encodeURIComponent(id)+"; Path=/; Max-Age=31536000; SameSite=Lax";return id}catch{return undefined}}
export default function AnalyticsTracker({reviewId,category,event="page_view"}:{reviewId?:string;category?:string;event?:EventName}){useEffect(()=>{const id=sessionId();fetch("/api/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reviewId,category,event,sessionId:id})}).catch(()=>{});},[reviewId,category,event]);return null}
