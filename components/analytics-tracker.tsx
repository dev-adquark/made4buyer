"use client";
import {useEffect} from "react";
export default function AnalyticsTracker({reviewId,category}:{reviewId:string;category:string}){useEffect(()=>{fetch("/api/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reviewId,category,event:"page_view"})}).catch(()=>{});},[reviewId,category]);return null;}